import { describe, expect, it } from "vitest";

import { applyRevision } from "@/lib/domain/revision";
import type { PendingRevision } from "@/lib/domain/types";

/**
 * A revision refused because the text it targeted changed (FR-015b).
 *
 * The revision is computed against the document the model saw. By the time it
 * arrives the user may have edited the very region it means to change, or
 * deleted it. Either way it is refused at apply time, told to the user as "the
 * document changed", and the content is left exactly as the user has it. This
 * is the rule that makes an in-flight edit safe to make.
 */

const DOCUMENT = [
  "# The Bronze Age",
  "",
  "Around 1200 BCE, the trade networks fell.",
  "",
  "The collapse was sudden.",
].join("\n");

const SENTENCE = "Around 1200 BCE, the trade networks fell.";

/** A targeted revision at the point of apply time. */
function revision(anchorText = SENTENCE, expectedText = SENTENCE): PendingRevision {
  return {
    targetRegion: { type: "anchor", anchorText },
    expectedText,
    replacementText: "Around 1200 BCE, the trade networks collapsed.",
    kind: "targeted",
    summary: "Sharpened the second sentence.",
  };
}

describe("a stale region (FR-015b)", () => {
  it("is refused when the region no longer holds the text the revision expected", () => {
    const edited = DOCUMENT.replace(SENTENCE, "Around 1200 BCE, everything changed.");

    const outcome = applyRevision(edited, revision());

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("is refused when the region was deleted entirely", () => {
    const withoutSentence = DOCUMENT.replace(`${SENTENCE}\n\n`, "");

    const outcome = applyRevision(withoutSentence, revision());

    expect(outcome).toMatchObject({ applied: false, reason: "stale_region" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("is refused when the user edited the region in a whitespace-only way", () => {
    // Whitespace is text: a region re-wrapped while the request was in flight
    // is not the region the revision was computed against.
    const rewrapped = DOCUMENT.replace(
      SENTENCE,
      "Around 1200 BCE, the  trade networks fell.",
    );

    expect(applyRevision(rewrapped, revision())).toMatchObject({
      applied: false,
      reason: "stale_region",
    });
  });

  it("still applies when the user edited a region the revision does not touch", () => {
    // An edit elsewhere does not make this revision stale; its own region is
    // intact, so the change it describes is still the change the user asked
    // for — and the edit they made is kept.
    const editedElsewhere = DOCUMENT.replace(
      "The collapse was sudden.",
      "The collapse was sudden, and complete.",
    );

    const outcome = applyRevision(editedElsewhere, revision());

    expect(outcome).toMatchObject({
      applied: true,
      content: editedElsewhere.replace(
        SENTENCE,
        "Around 1200 BCE, the trade networks collapsed.",
      ),
    });
  });

  describe("a refusal leaves the content untouched", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "the region was edited",
        DOCUMENT.replace(SENTENCE, "Around 1200 BCE, the networks held."),
      ],
      ["the region was deleted", DOCUMENT.replace(`${SENTENCE}\n\n`, "")],
      ["the document was emptied", ""],
      ["the document was replaced", "# Something else entirely"],
    ];

    it.each(cases)("when %s", (_name, content) => {
      const outcome = applyRevision(content, revision());

      expect(outcome.applied).toBe(false);
      expect(outcome).not.toHaveProperty("content");
      // A caller that ignored `applied` and read `content` would get nothing
      // rather than text that silently differs from what the user had.
      expect(JSON.stringify(outcome)).not.toContain(content.slice(0, 40) || "\u0000");
    });
  });

  it("tells a stale region apart from a quote that never existed", () => {
    // A revision computed against text this document never contained is the
    // model's error, not a user edit: the two get different reasons and
    // messages so the user is not blamed for an edit they did not make.
    const never = applyRevision(DOCUMENT, revision("A sentence that is not here.", ""));

    expect(never).toMatchObject({ applied: false, reason: "region_missing" });
    expect(
      applyRevision(DOCUMENT.replace(SENTENCE, "Changed."), revision()),
    ).toMatchObject({
      reason: "stale_region",
    });
  });
});
