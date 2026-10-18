import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@/lib/ai/prompt";
import { applyDocumentRevisionInputSchema, toPendingRevision } from "@/lib/ai/tools";
import { applyRevision } from "@/lib/domain/revision";
import type { Style } from "@/lib/domain/types";

/**
 * The four kinds of change a writer asks for (FR-013, FR-015).
 *
 * A correction, an expansion, a reduction, and a tone change are all edits of
 * part of the script. The request decides what the model is told; the tool
 * call decides what changes. What this test holds is the second half: each kind
 * is expressed as a region-addressed change, the document rules apply it to
 * that region alone, and the rest of the script is byte-identical afterwards.
 */

const STYLE: Style = {
  id: "historical-documentary",
  name: "Historical Documentary",
  description: "Measured, evidence-led.",
  guidance: "Write in a measured, evidence-led register.",
};

const DOCUMENT = [
  "# The Bronze Age",
  "",
  "Around 1200 BCE, the trade networks fell.",
  "",
  "The palace economies never recovered.",
  "",
  "Historians still argue about why.",
].join("\n");

const FELL = "Around 1200 BCE, the trade networks fell.";
const PALACES = "The palace economies never recovered.";
const ARGUE = "Historians still argue about why.";

/** One revision as the model would call the tool for it. */
function call(
  targetRegion: unknown,
  expectedText: string,
  replacementText: string,
  summary: string,
) {
  return applyDocumentRevisionInputSchema.parse({
    targetRegion,
    expectedText,
    replacementText,
    summary,
  });
}

const KINDS = [
  {
    name: "a correction",
    region: { anchorText: FELL },
    expectedText: FELL,
    replacementText: "Around 1177 BCE, the trade networks fell.",
    summary: "Corrected the date.",
    changed: FELL,
  },
  {
    name: "an expansion",
    region: { anchorText: PALACES },
    expectedText: PALACES,
    replacementText: "The palace economies never recovered: their records simply stop.",
    summary: "Expanded on the palace economies.",
    changed: PALACES,
  },
  {
    name: "a reduction",
    region: { anchorText: ARGUE },
    expectedText: ARGUE,
    replacementText: "The cause is still argued.",
    summary: "Shortened the closing line.",
    changed: ARGUE,
  },
  {
    name: "a tone change",
    region: { anchorText: FELL },
    expectedText: FELL,
    replacementText: "Then, around 1200 BCE, the networks gave way.",
    summary: "Made the opening colder.",
    changed: FELL,
  },
] as const;

describe.each(KINDS)(
  "$name",
  ({ region, expectedText, replacementText, summary, changed }) => {
    it("is a region-addressed edit of the part it names", () => {
      const revision = toPendingRevision(
        call(region, expectedText, replacementText, summary),
      );

      expect(revision.targetRegion.type).toBe("anchor");
      expect(revision.summary).toBe(summary);
    });

    it("changes only its region: everything else is byte-identical", () => {
      const revision = toPendingRevision(
        call(region, expectedText, replacementText, summary),
      );
      const outcome = applyRevision(DOCUMENT, revision);

      expect(outcome.applied).toBe(true);

      const content = (outcome as { content: string }).content;
      const before = DOCUMENT.split(changed);
      const after = content.split(replacementText);

      // The text before and after the region is exactly what it was.
      expect(before).toHaveLength(2);
      expect(after).toHaveLength(2);
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it("is not a whole-document rewrite", () => {
      const revision = toPendingRevision(
        call(region, expectedText, replacementText, summary),
      );

      expect(revision.kind).toBe("targeted");
      expect(revision.targetRegion).not.toEqual({ type: "whole-document" });
    });
  },
);

describe("the request kinds", () => {
  it("tells the model that an edit request must not be answered with a rewrite", () => {
    // The rule the model reads and the rule the document enforces are the same
    // rule; this reads the one the model is given, so the two cannot drift.
    const system = buildSystemPrompt({ style: STYLE, document: DOCUMENT });

    expect(system).toMatch(/Text you do not name is never touched/);
    expect(system).toMatch(/not a whole-document rewrite|never rewrite the whole/i);
  });
});
