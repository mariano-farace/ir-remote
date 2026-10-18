import { describe, expect, it } from "vitest";

import { applyRevision } from "@/lib/domain/revision";
import type { PendingRevision } from "@/lib/domain/types";

/**
 * Region matching at the contract level (contracts/tool-call.md rules 2–3).
 *
 * T043 extends this file with the full region-resolution matrix in US2; these
 * are the cases the US1 store relies on to tell a conflict from an ambiguity.
 */

const DRAFT = "# The Bronze Age\n\nAround 1200 BCE, the networks fell.";

const TARGETED: PendingRevision = {
  targetRegion: { type: "anchor", anchorText: "Around 1200 BCE, the networks fell." },
  expectedText: "Around 1200 BCE, the networks fell.",
  replacementText: "Around 1200 BCE, the networks collapsed.",
  kind: "targeted",
  summary: "Changed the verb.",
};

describe("applyRevision region matching", () => {
  it("counts overlapping occurrences when checking that an anchor is unique", () => {
    // "x" + "ab"*12 repeats "ababab": the second occurrence starts one
    // character after the first, which a split-and-count would miss.
    const anchorText = `abababababab`;
    const document = `${anchorText}${anchorText}`;

    const outcome = applyRevision(document, {
      ...TARGETED,
      targetRegion: { type: "anchor", anchorText },
      expectedText: anchorText,
    });

    expect(outcome).toMatchObject({ applied: false, reason: "region_ambiguous" });
  });

  it("reports a revision stale, not ambiguous, when the user already edited its target (FR-015b)", () => {
    const edited = DRAFT.replace("the networks fell.", "the networks buckled.");

    const outcome = applyRevision(edited, TARGETED);

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("applies a matching anchor and reports the replaced span", () => {
    const outcome = applyRevision(DRAFT, TARGETED);

    expect(outcome).toMatchObject({
      applied: true,
      content: "# The Bronze Age\n\nAround 1200 BCE, the networks collapsed.",
      kind: "targeted",
      regionStart: DRAFT.indexOf("Around 1200 BCE, the networks fell."),
      regionEnd:
        DRAFT.indexOf("Around 1200 BCE, the networks fell.") +
        "Around 1200 BCE, the networks fell.".length,
    });
  });

  it("reports a revision stale when the whole-document text moved on", () => {
    const outcome = applyRevision(DRAFT, {
      ...TARGETED,
      targetRegion: { type: "whole-document" },
      expectedText: "An earlier draft.",
    });

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
  });
});

describe("T043 region resolution", () => {
  it("applies when the anchor is found exactly once", () => {
    const outcome = applyRevision(DRAFT, TARGETED);

    expect(outcome).toMatchObject({ applied: true });
    expect(outcome).not.toHaveProperty("reason");
    expect(outcome.applied && outcome.content).toBe(
      "# The Bronze Age\n\nAround 1200 BCE, the networks collapsed.",
    );
  });

  it("rejects an anchor found twice as ambiguous, leaving the document untouched", () => {
    const repeated = "A line about salt.\n\nA line about salt.";
    const revision: PendingRevision = {
      targetRegion: { type: "anchor", anchorText: "A line about salt." },
      expectedText: "A line about salt.",
      replacementText: "A line about cobalt.",
      kind: "targeted",
      summary: "Changed the subject.",
    };

    const outcome = applyRevision(repeated, revision);

    expect(outcome).toMatchObject({ applied: false, reason: "region_ambiguous" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("rejects a region whose expectedText does not match as stale", () => {
    const revision: PendingRevision = {
      ...TARGETED,
      expectedText: "the networks rose.",
    };

    const outcome = applyRevision(DRAFT, revision);

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("rejects a revision whose region was deleted as stale", () => {
    // The quote is gone and `expectedText` is gone with it: the sentence the
    // revision was written against was deleted from the document.
    const revision: PendingRevision = {
      ...TARGETED,
      targetRegion: { type: "anchor", anchorText: "the Silk Roads flourished." },
      expectedText: "the Silk Roads flourished.",
      replacementText: "the Silk Roads collapsed.",
      kind: "targeted",
      summary: "Changed the sentence.",
    };

    const outcome = applyRevision(DRAFT, revision);

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("rejects an empty replacement over non-empty content without confirmation (FR-021)", () => {
    const revision: PendingRevision = {
      ...TARGETED,
      replacementText: "",
      summary: "Removed the sentence.",
    };

    const outcome = applyRevision(DRAFT, revision);

    expect(outcome).toMatchObject({
      applied: false,
      reason: "clear_requires_confirmation",
    });
    expect(outcome).not.toHaveProperty("content");
  });
});

describe("T047 region resolution rules", () => {
  it("names a region the model quoted from nowhere as missing, not stale", () => {
    // The model expected nothing to be there: it invented the quote rather
    // than describing text the user changed.
    const outcome = applyRevision(DRAFT, {
      ...TARGETED,
      targetRegion: {
        type: "anchor",
        anchorText: "The Silk Roads flourished in the third century.",
      },
      expectedText: "",
    });

    expect(outcome).toMatchObject({ applied: false, reason: "region_missing" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("rejects a short anchor that occurs several times as ambiguous", () => {
    // The 20-character floor is the tool schema's rule (contracts/tool-call.md);
    // a quote that does reach this function must still be unique.
    const document = "The salt roads turned north. Then the salt roads turned again.";

    const outcome = applyRevision(document, {
      ...TARGETED,
      targetRegion: { type: "anchor", anchorText: "salt roads" },
      expectedText: "salt roads",
    });

    expect(outcome).toMatchObject({ applied: false, reason: "region_ambiguous" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("applies an empty replacement over non-empty content once it is explicitly confirmed (FR-021)", () => {
    const paragraph = "Around 1200 BCE, the networks fell.";
    const revision: PendingRevision = {
      targetRegion: { type: "anchor", anchorText: paragraph },
      expectedText: paragraph,
      replacementText: "",
      kind: "targeted",
      summary: "Removed the sentence.",
    };

    // The confirmation lifts only the anti-clear rule; the region still has to
    // match, which this revision's does.
    const cleared = applyRevision(DRAFT, revision, { clearConfirmed: true });

    expect(cleared).toMatchObject({ applied: true, content: "# The Bronze Age\n\n" });
  });

  it("never lifts the anti-clear rule for anything but an explicit confirmation", () => {
    const paragraph = "Around 1200 BCE, the networks fell.";
    const revision = {
      targetRegion: { type: "anchor" as const, anchorText: paragraph },
      expectedText: paragraph,
      replacementText: "",
      kind: "targeted" as const,
      summary: "Removed the sentence.",
    };

    expect(applyRevision(DRAFT, revision, { clearConfirmed: false })).toMatchObject({
      applied: false,
      reason: "clear_requires_confirmation",
    });
    expect(applyRevision(DRAFT, revision)).toMatchObject({
      applied: false,
      reason: "clear_requires_confirmation",
    });
  });

  it("a whitespace-only replacement is also a clear, and is refused without confirmation", () => {
    const paragraph = "Around 1200 BCE, the networks fell.";

    const outcome = applyRevision(DRAFT, {
      targetRegion: { type: "anchor", anchorText: paragraph },
      expectedText: paragraph,
      replacementText: "   \n",
      kind: "targeted",
      summary: "Removed the sentence.",
    });

    expect(outcome).toMatchObject({
      applied: false,
      reason: "clear_requires_confirmation",
    });
  });
});

describe("first-draft handling (FR-015c, first case)", () => {
  const FIRST_DRAFT: PendingRevision = {
    targetRegion: { type: "whole-document" },
    expectedText: "",
    replacementText: "# The Bronze Age\n\nAround 1200 BCE, the networks fell.",
    kind: "first-draft",
    summary: "Wrote a first draft.",
  };

  it("accepts a wholesale draft into an empty document", () => {
    expect(applyRevision("", FIRST_DRAFT)).toMatchObject({
      applied: true,
      content: FIRST_DRAFT.replacementText,
    });
  });

  it("refuses a wholesale draft over a document that is only whitespace", () => {
    // "empty" means no text; blank lines are text the user could have typed.
    expect(applyRevision("  \n\n ", FIRST_DRAFT)).toMatchObject({
      applied: false,
      reason: "wholesale_on_non_empty",
    });
  });

  it("refuses a wholesale draft over a non-empty document, leaving it untouched", () => {
    const outcome = applyRevision(DRAFT, { ...FIRST_DRAFT, expectedText: DRAFT });

    expect(outcome).toMatchObject({ applied: false, reason: "wholesale_on_non_empty" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("refuses a whole-document rewrite over existing text, not only a draft (FR-015c)", () => {
    // The second permitted case of a full-document write needs the user's
    // confirmation; without it a whole-document replacement is refused, so a
    // request framed as a targeted edit can never be answered with a rewrite.
    const rewrite: PendingRevision = {
      ...FIRST_DRAFT,
      kind: "wholesale-rewrite",
      expectedText: DRAFT,
      summary: "Rewrote the script.",
    };

    expect(applyRevision(DRAFT, rewrite)).toMatchObject({ applied: false });
    expect(applyRevision(DRAFT, rewrite)).not.toHaveProperty("content");
  });

  it("applies the rewrite once the user has confirmed it, recoverably", () => {
    // FR-015c, second case: an explicit, confirmed rewrite is the only other
    // permitted whole-document write. The prior text is captured as a revision
    // by the repository before the change lands, so it stays recoverable.
    const rewrite: PendingRevision = {
      ...FIRST_DRAFT,
      kind: "wholesale-rewrite",
      expectedText: DRAFT,
      replacementText: "# A completely different script",
      summary: "Rewrote the script.",
    };

    const outcome = applyRevision(DRAFT, rewrite, { rewriteConfirmed: true });

    expect(outcome).toMatchObject({
      applied: true,
      content: "# A completely different script",
      kind: "wholesale-rewrite",
    });
  });

  it("does not let a first draft claim act as consent to rewrite", () => {
    // A draft is a different thing from a rewrite the user asked for; consent
    // to one is not consent to the other.
    const rewrite: PendingRevision = {
      ...FIRST_DRAFT,
      kind: "wholesale-rewrite",
      expectedText: DRAFT,
    };

    expect(applyRevision(DRAFT, rewrite, { clearConfirmed: true })).toMatchObject({
      applied: false,
      reason: "wholesale_on_non_empty",
    });
  });
});
