/**
 * A revision's application to a document: pure, total, and framework-free.
 *
 * This module answers exactly one question — *what does the document look like
 * after this revision, if the revision is allowed?* — and answers it without
 * throwing and without partial writes. A revision that cannot be applied is
 * reported as a typed rejection (contracts/tool-call.md, rejection rules 1–5),
 * and the caller decides how to surface it.
 *
 * Principle IV is why the validation lives here rather than in the route: the
 * same function is cheap enough to run twice, once on the server (to refuse a
 * bad tool call before it is streamed) and once in the browser (because the
 * document may have changed in the meantime).
 */

import type { PendingRevision, RevisionKind, RevisionRegion } from "@/lib/domain/types";

/** A region quote shorter than this cannot identify a unique span in practice. */
export const MIN_ANCHOR_LENGTH = 20;

/** The distinguishable reasons a revision is refused. Mirrors the contract's rules. */
export type RevisionRejectionReason =
  /**
   * Rule 2: the anchor is too short to identify a span, or occurs more than
   * once. Either way the model has not said which text it means.
   */
  | "region_ambiguous"
  /** Rule 2: the anchor does not occur in the document at all. */
  | "region_missing"
  /** Rule 3: `expectedText` no longer matches the region (FR-015b). */
  | "stale_region"
  /** Rule 4: a wholesale draft against a non-empty document (FR-015c). */
  | "wholesale_on_non_empty"
  /** Rule 5: an empty replacement over a non-empty document (FR-021). */
  | "clear_requires_confirmation";

/** A revision that may be applied, with the region resolved to string indices. */
export interface AppliedRevision {
  readonly applied: true;
  /** The whole document after the change. */
  readonly content: string;
  readonly kind: RevisionKind;
  /** Start index of the replaced span in the original document. */
  readonly regionStart: number;
  /** End index (exclusive) of the replaced span in the original document. */
  readonly regionEnd: number;
  readonly summary: string;
}

/** A revision that may not be applied. `content` is untouched by construction. */
export interface RejectedRevision {
  readonly applied: false;
  readonly reason: RevisionRejectionReason;
  /** A user-facing sentence naming what happened (FR-022a). */
  readonly message: string;
}

export type RevisionOutcome = AppliedRevision | RejectedRevision;

/** What the caller has established beyond the revision itself. */
export interface ApplyRevisionOptions {
  /**
   * The user explicitly confirmed that the script may be cleared (FR-021).
   *
   * Only the user can supply this. `PendingRevision` carries no confirmation
   * field precisely so that model output cannot set it: a tool call claiming
   * `confirmedClear` is still just model output (Principle IV).
   */
  readonly clearConfirmed?: boolean;

  /**
   * The user explicitly asked for and confirmed a rewrite of the whole script
   * (FR-015c, second case).
   *
   * Like `clearConfirmed`, only the user can supply it: the client sets it
   * after an approved answer to the rewrite question, never from anything the
   * model said (Principle IV).
   */
  readonly rewriteConfirmed?: boolean;
}

/**
 * Where the region is, or why it cannot be located.
 *
 * `ambiguous` means the model's own quote is unusable (contract rule 2).
 * `quote-missing` means the model quoted text the document does not contain.
 * `applyRevision` tells the two apart by `expectedText`: when the region held
 * text at compute time and that text is gone, the user edited it mid-request
 * (FR-015b, stale); with nothing expected there, the model misquoted
 * (`region_missing`). A region that is found but holds other text is stale too.
 */
type RegionLocation =
  | { readonly located: true; readonly start: number; readonly end: number }
  | { readonly located: false; readonly reason: "ambiguous" | "quote-missing" };

function locateRegion(content: string, region: RevisionRegion): RegionLocation {
  if (region.type === "whole-document") {
    return { located: true, start: 0, end: content.length };
  }

  const first = content.indexOf(region.anchorText);
  // A second occurrence, searched for from one character after the first,
  // catches overlapping repeats that a split-and-count would miss.
  const second = first === -1 ? -1 : content.indexOf(region.anchorText, first + 1);

  // The quote occurs nowhere. The model may simply have misquoted the
  // document, so `expectedText` is compared below before the user is blamed.
  if (first === -1) {
    return { located: false, reason: "quote-missing" };
  }

  if (second !== -1) {
    return { located: false, reason: "ambiguous" };
  }

  return { located: true, start: first, end: first + region.anchorText.length };
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/**
 * Applies a revision to `content` if the contract allows it.
 *
 * Pure: the same inputs always produce the same outcome, and nothing outside
 * the resolved region changes (FR-015a) — the result is the original string
 * with one contiguous span replaced, so surviving text cannot be reflowed.
 */
export function applyRevision(
  content: string,
  revision: PendingRevision,
  options: ApplyRevisionOptions = {},
): RevisionOutcome {
  // A draft is allowed only into an empty document (FR-015c, first case).
  // Checked before the region comparison because a draft's premise is "there
  // was nothing here", so any text at all — including blank lines — makes the
  // wholesale-write rule the clearer diagnosis than a stale region.
  if (revision.kind === "first-draft" && content !== "") {
    return {
      applied: false,
      reason: "wholesale_on_non_empty",
      message:
        "A first draft can only be written into an empty script. The existing text was left unchanged.",
    };
  }

  const location = locateRegion(content, revision.targetRegion);

  // A quote that is unusable on its own terms is the model's error.
  if (!location.located && location.reason === "ambiguous") {
    return {
      applied: false,
      reason: "region_ambiguous",
      message:
        "The change could not be located: its target text does not appear exactly once in the script.",
    };
  }

  if (!location.located) {
    // The anchor quote is absent. `expectedText` is the discriminator: a
    // revision computed against existing text whose text is now gone describes
    // an edit the user made mid-request (FR-015b). With no expected text there
    // is nothing to have been edited, and no region to find.
    const editedSinceRequest = revision.expectedText.trim() !== "";

    return editedSinceRequest
      ? {
          applied: false,
          reason: "stale_region",
          message:
            "The document changed while the request was in progress, so the change was not applied.",
        }
      : {
          applied: false,
          reason: "region_missing",
          message:
            "The change could not be located: its target text is not in the script.",
        };
  }

  const currentRegion = content.slice(location.start, location.end);

  if (currentRegion !== revision.expectedText) {
    return {
      applied: false,
      reason: "stale_region",
      message:
        "The document changed while the request was in progress, so the change was not applied.",
    };
  }

  // The only other permitted full-document write is an explicit, confirmed
  // rewrite (FR-015c, second case). Any other whole-document replacement over
  // existing text is refused, so a request framed as a targeted edit can never
  // be answered with a rewrite.
  if (
    revision.targetRegion.type === "whole-document" &&
    content !== "" &&
    !options.rewriteConfirmed
  ) {
    return {
      applied: false,
      reason: "wholesale_on_non_empty",
      message:
        "Replacing the whole script needs your confirmation. The existing text was left unchanged.",
    };
  }

  if (isBlank(revision.replacementText) && !isBlank(content) && !options.clearConfirmed) {
    return {
      applied: false,
      reason: "clear_requires_confirmation",
      message:
        "This change would clear the script. Confirm that you want to remove all of its text.",
    };
  }

  return {
    applied: true,
    content:
      content.slice(0, location.start) +
      revision.replacementText +
      content.slice(location.end),
    kind: revision.kind,
    regionStart: location.start,
    regionEnd: location.end,
    summary: revision.summary,
  };
}
