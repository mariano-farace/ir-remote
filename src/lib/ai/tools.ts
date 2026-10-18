/**
 * The single tool the model may call (contracts/tool-call.md).
 *
 * Model output is untrusted input (Principle IV), so there are two gates and
 * they do different jobs:
 *
 *  1. `applyDocumentRevisionInputSchema` proves the payload is *shaped*
 *     correctly. A failure is a model fault and is reported as such.
 *  2. `validateDocumentRevision` applies the contract's document-dependent
 *     rules — region uniqueness, staleness, wholesale bounds, the anti-clear
 *     guard — through `src/lib/domain/revision.ts`.
 *
 * `confirmedClear` deserves the emphasis the contract gives it: it is *not* in
 * the schema at all, so a model that emits it is silently stripped before the
 * value is ever read. Consent to clear a document can only come from a separate
 * user act (FR-021), never from the model's own assertion.
 *
 * Server-only in practice: the schema is also imported by the client to type
 * its tool parts, which is why this module holds no secrets or providers.
 */

import { tool, type SingleToolApprovalFunction, type Tool } from "ai";
import { z } from "zod";

import {
  MIN_ANCHOR_LENGTH,
  applyRevision,
  type AppliedRevision,
  type RevisionOutcome,
} from "@/lib/domain/revision";
import type { PendingRevision, RevisionRegion } from "@/lib/domain/types";

/** The summary shown in the chat: one sentence, within the contract's limit. */
export const SUMMARY_MAX_LENGTH = 200;

const wholeDocumentRegion = z
  .object({
    wholeDocument: z.literal(true),
    anchorText: z.never().optional(),
  })
  .strict();

const anchorRegion = z
  .object({
    wholeDocument: z.never().optional(),
    anchorText: z
      .string()
      .min(
        MIN_ANCHOR_LENGTH,
        `An anchor must quote at least ${MIN_ANCHOR_LENGTH} characters of the script`,
      ),
  })
  .strict();

export const applyDocumentRevisionInputSchema = z.object({
  targetRegion: z
    .union([wholeDocumentRegion, anchorRegion])
    .describe(
      "Required. Exactly one of: { wholeDocument: true } for a first draft or full " +
        "rewrite, or { anchorText }, a verbatim quote of at least 20 characters that " +
        "occurs exactly once in the script.",
    ),
  expectedText: z
    .string()
    .describe(
      "The text the target region currently holds, quoted verbatim. Empty for a first draft.",
    ),
  replacementText: z
    .string()
    .describe(
      "The new text for the target region only. May be empty only with explicit user approval.",
    ),
  isWholesaleDraft: z
    .boolean()
    .default(false)
    .describe("True only for the very first draft of an empty script."),
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX_LENGTH)
    .describe("Required. One sentence describing the change, shown in the chat."),
});

/** The tool input after schema validation. */
export type DocumentRevisionInput = z.output<typeof applyDocumentRevisionInputSchema>;

export const APPLY_DOCUMENT_REVISION_TOOL_NAME = "apply_document_revision";

/**
 * The description handed to the model: the contract's text plus the one shape
 * rule models reliably get wrong. A call that omits `targetRegion` is refused
 * outright, and the SDK rejects it before execution, so the two valid region
 * forms and the required `summary` are named in the description the model
 * reads alongside the schema.
 */
export const APPLY_DOCUMENT_REVISION_DESCRIPTION =
  "Apply a change to the documentary script. You MUST identify the exact text you are " +
  "replacing and quote it verbatim in `expectedText`. Text you do not include in " +
  "`targetRegion` will not be touched, so supply only the change you were asked for. " +
  "For the very first draft of an empty document, set `isWholesaleDraft` to true, set " +
  '`targetRegion` to {"wholeDocument": true}, and leave `expectedText` empty. ' +
  "Every call MUST include `targetRegion` as exactly one of " +
  '{"wholeDocument": true} or {"anchorText": "<the exact text being replaced>"}, ' +
  "and a one-sentence `summary`. A call without `targetRegion` is refused.";

/**
 * What the tool's `execute` returns: the validated revision, or the reason it
 * was refused. A refusal is a structured *result*, not a thrown error, so the
 * assistant message shows the user why nothing changed.
 */
/** A payload that failed the schema gate, before any document rule was reached. */
export interface InvalidRevisionOutcome {
  readonly applied: false;
  readonly reason: "validation_error";
  readonly message: string;
  readonly detail: string;
}

/**
 * An applied revision: the server's result plus the validated revision it
 * applied. The revision travels to the browser so the client can re-run the
 * same rules against its own document before writing (Principle III); the
 * `content` is informational — the client never writes it directly.
 */
export interface AppliedDocumentRevision extends AppliedRevision {
  readonly revision: PendingRevision;
}

export type DocumentRevisionResult =
  AppliedDocumentRevision | ExcludedRevision | InvalidRevisionOutcome;

/** A revision the document rules refused, carrying the user-facing reason. */
export type ExcludedRevision = Extract<RevisionOutcome, { applied: false }>;

function toRegion(input: DocumentRevisionInput): RevisionRegion {
  return "anchorText" in input.targetRegion && input.targetRegion.anchorText !== undefined
    ? { type: "anchor", anchorText: input.targetRegion.anchorText }
    : { type: "whole-document" };
}

/**
 * Maps a validated tool call onto a pending revision.
 *
 * `confirmedClear` is deliberately absent from {@link DocumentRevisionInput};
 * nothing in this path can set it, which is what makes the anti-clear guard
 * hold even against a model that claims the user authorised it.
 */
export function toPendingRevision(input: DocumentRevisionInput): PendingRevision {
  const region = toRegion(input);

  const kind = input.isWholesaleDraft
    ? "first-draft"
    : region.type === "whole-document"
      ? "wholesale-rewrite"
      : "targeted";

  return {
    targetRegion: region,
    expectedText: input.expectedText,
    replacementText: input.replacementText,
    kind,
    summary: input.summary,
  };
}

/**
 * Runs a validated tool call against the current document.
 *
 * @param rawInput The tool call's arguments as the model produced them. They
 *   have already passed the schema when called through the SDK's `execute`, but
 *   they are re-validated here so a direct caller cannot skip the first gate.
 * @param content The document as stored server-side, never as the client sent it.
 */
export function validateDocumentRevision(
  rawInput: unknown,
  content: string,
  options: { readonly rewriteConfirmed?: boolean } = {},
): DocumentRevisionResult {
  const parsed = applyDocumentRevisionInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return {
      applied: false,
      reason: "validation_error",
      message: "The assistant's change could not be validated and was not applied.",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    };
  }

  const revision = toPendingRevision(parsed.data);
  // No `clearConfirmed` is offered here: the schema has no field for it, so a
  // model's claim cannot reach this call. A clearing change is put to the user
  // by `documentRevisionApproval`, and consent arrives on the client, where
  // `applyProposal` is given `clearConfirmed` only after an approved answer.
  // The same holds for a full rewrite: `rewriteConfirmed` comes from the
  // approved answer, not from the payload.
  const outcome = applyRevision(content, revision, {
    rewriteConfirmed: options.rewriteConfirmed === true,
  });

  return outcome.applied ? { ...outcome, revision } : outcome;
}

/**
 * The anti-clear guard's server half (FR-021, contracts/tool-call.md).
 *
 * Passed to `streamText` as `toolApproval`. It runs before `execute`, so a call
 * that would remove all of a non-empty script's text never executes on the
 * model's say-so: the SDK emits an approval request instead, and the client
 * answers it through `addToolApprovalResponse`. An approved answer re-runs the
 * call, at which point the same revision is applied with the user's consent; a
 * declined answer ends the call without execution, so nothing is written.
 *
 * Only the clearing case is put to the user. Everything else is left to
 * `execute`, which still reports it as a refused result rather than a prompt.
 *
 * `document` is the text the server loaded for this request, the same value the
 * `execute` side validates against.
 */
/**
 * The two questions an approval can be: the clear guard, and the explicit
 * rewrite a non-empty script requires. The client renders each in its own
 * words and sends the answer back as the tool call's reason, so the server and
 * the browser agree on what was asked.
 */
export type RevisionApprovalQuestion = "clear" | "rewrite";

/** An answer the user must give: `{ reason }` is what the client receives. */
export function userApproval(reason: RevisionApprovalQuestion) {
  return { type: "user-approval" as const, reason };
}

/**
 * The approved question an earlier tool call in this step carried.
 *
 * When a call needs the user's answer, `streamText` ends the step; the client's
 * answer arrives as a new request, and the call re-runs in a later step whose
 * messages still contain the approval response. That response is the consent —
 * `{ approved: true, reason: "clear" | "rewrite" }` — and this is where it is
 * read. Nothing the model wrote can produce it: a model's message carries no
 * approval response at all (Principle IV).
 */
export function approvedQuestion(
  messages: readonly unknown[],
): RevisionApprovalQuestion | null {
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }

      // `streamText` re-runs a held call itself when the user's answer
      // arrives, and hands the tool the conversation: the answer is there as
      // a `tool-approval-response`, not yet as a stored result's approval.
      if (
        (part as { type?: unknown }).type === "tool-approval-response" &&
        (part as { approved?: unknown }).approved === true
      ) {
        const reason = (part as { reason?: unknown }).reason;

        if (reason === "clear" || reason === "rewrite") {
          return reason;
        }

        continue;
      }

      const approval = (part as { approval?: unknown }).approval;

      if (
        typeof approval === "object" &&
        approval !== null &&
        (approval as { approved?: unknown }).approved === true
      ) {
        const reason = (approval as { reason?: unknown }).reason;

        if (reason === "clear" || reason === "rewrite") {
          return reason;
        }
      }
    }
  }

  return null;
}

export function documentRevisionApproval(
  document: string,
): SingleToolApprovalFunction<DocumentRevisionInput, unknown, unknown> {
  return (input) => {
    const parsed = applyDocumentRevisionInputSchema.safeParse(input);

    if (!parsed.success) {
      return "not-applicable";
    }

    const outcome = applyRevision(document, toPendingRevision(parsed.data));

    if (outcome.applied) {
      return "not-applicable";
    }

    // Two questions, told apart so the client can ask the right one: the clear
    // guard, and the explicit rewrite an existing script requires (FR-015c).
    if (outcome.reason === "clear_requires_confirmation") {
      return userApproval("clear");
    }

    return outcome.reason === "wholesale_on_non_empty"
      ? userApproval("rewrite")
      : "not-applicable";
  };
}

/**
 * The shape of the revision tool. Declared once so every step's tool — the
 * first, and the one rebuilt with an approval — is the same type to the SDK.
 */
export type ScriptRevisionTool = Tool<DocumentRevisionInput, DocumentRevisionResult>;

/**
 * The tool handed to `streamText`, executed on the server.
 *
 * `document` is the script's content as the server loaded it for this request —
 * never something the client sent and never a value captured at module load,
 * so each request validates against the text the user has now (FR-014).
 *
 * The result is the whole tool outcome, applied content included. The client
 * also receives it, but it does not trust it: `applyProposal` re-runs the same
 * rules against the browser's document before anything changes there.
 *
 * The tool itself needs no approval flag: the decision lives in
 * {@link documentRevisionApproval}, which `streamText` evaluates first.
 */
export function createApplyDocumentRevisionTool({
  document,
}: {
  readonly document: string;
}): ScriptRevisionTool {
  return tool({
    description: APPLY_DOCUMENT_REVISION_DESCRIPTION,
    inputSchema: applyDocumentRevisionInputSchema,
    // The user's answer is in the messages this call was made against: only an
    // approved *rewrite* question is consent to rewrite (FR-015c); no answer,
    // a decline, or a clear is not. The model's own messages carry no approval
    // response, so nothing it wrote can stand in for the user (Principle IV).
    execute: (input: DocumentRevisionInput, { messages }): DocumentRevisionResult =>
      validateDocumentRevision(input, document, {
        rewriteConfirmed: approvedQuestion(messages) === "rewrite",
      }),
  });
}
