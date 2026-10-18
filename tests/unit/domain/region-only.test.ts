import { describe, expect, it } from "vitest";

import { applyRevision } from "@/lib/domain/revision";
import type { PendingRevision } from "@/lib/domain/types";

/**
 * FR-015a, FR-016: an AI revision changes its region and nothing else.
 *
 * The guarantee is structural — the new document is the old one with one
 * contiguous span replaced — so it has to hold for whatever surrounds the
 * region, however badly the model reformats its own replacement. Text the
 * model never named is not reflowed, reordered, re-joined, or normalized.
 */

const REGION = "Around 1200 BCE, the trade networks fell.";

const REPLACEMENT = "Around 1200 BCE, the trade networks collapsed.";

function targeted(document: string, replacement = REPLACEMENT): PendingRevision {
  return {
    targetRegion: { type: "anchor", anchorText: REGION },
    expectedText: REGION,
    replacementText: replacement,
    kind: "targeted",
    summary: "Changed the verb.",
  };
}

/** Everything outside the region, byte for byte. */
function outside(
  document: string,
  outcome: { content: string; regionStart: number; regionEnd: number },
) {
  return {
    before: document.slice(0, outcome.regionStart),
    after: document.slice(outcome.regionEnd),
  };
}

describe("a revision applies only within its region", () => {
  const surrounds: Record<string, string> = {};

  surrounds["CRLF line endings"] =
    `# Bronze Age\r\n\r\n${REGION}\r\n\r\nTrade collapsed soon after.\r\n`;
  surrounds["trailing spaces"] =
    `# Bronze Age   \n\nIntro paragraph.   \n\n${REGION}  \n\nClosing line.\n`;
  surrounds["tabs and irregular blank lines"] = `Title\n\n\n\t${REGION}\n\n\n\nEnd\n`;
  surrounds["setext headings and spaced emphasis"] =
    `Why The Networks Fell\n=====================\n\n*leaning* and **bold**  text\n\n${REGION}\n\n1. first\n2.  second\n`;
  surrounds["text that reflowing would change"] =
    `A line that ends here\nand continues here\n\n${REGION}\n\nHard   spaces\t and   commas, are\nmeaningful.\n`;
  surrounds["no trailing newline"] = `Opening.\n\n${REGION}`;

  for (const [name, document] of Object.entries(surrounds)) {
    it(`leaves everything outside the region untouched when there are ${name}`, () => {
      const outcome = applyRevision(document, targeted(document));

      expect(outcome.applied).toBe(true);

      if (!outcome.applied) {
        return;
      }

      const { before, after } = outside(document, outcome);

      expect(document.slice(outcome.regionStart, outcome.regionEnd)).toBe(REGION);
      expect(outcome.content).toBe(before + REPLACEMENT + after);
    });

    it(`keeps the surrounding text when the replacement itself is badly formatted (${name})`, () => {
      // The model's own text is written as it arrives — reflowing it would be
      // a silent edit of the user's region — and the rest of the document is
      // not touched by whatever shape it takes.
      const messy =
        "Rewrote   the\tline\r\nwith *odd*\nspacing   and no trailing newline";
      const outcome = applyRevision(document, targeted(document, messy));

      expect(outcome.applied).toBe(true);

      if (!outcome.applied) {
        return;
      }

      const { before, after } = outside(document, outcome);

      expect(outcome.content).toBe(before + messy + after);
      expect(
        outcome.content.slice(outcome.regionStart, outcome.regionStart + messy.length),
      ).toBe(messy);
    });
  }

  it("changes the length of the document only by the difference in region length", () => {
    const document = surrounds["CRLF line endings"];
    const outcome = applyRevision(document, targeted(document));

    expect(outcome.applied).toBe(true);

    if (!outcome.applied) {
      return;
    }

    expect(outcome.content.length - document.length).toBe(
      REPLACEMENT.length - REGION.length,
    );
  });

  it("reports the region it changed, and only that span differs", () => {
    const document = surrounds["trailing spaces"];
    const outcome = applyRevision(document, targeted(document));

    expect(outcome.applied).toBe(true);

    if (!outcome.applied) {
      return;
    }

    let differing = 0;

    for (
      let index = 0;
      index < Math.max(document.length, outcome.content.length);
      index++
    ) {
      if (document[index] !== outcome.content[index]) {
        differing++;
      }
    }

    // Only the region's own characters can differ (plus the tail that shifts).
    expect(outcome.regionStart).toBe(document.indexOf(REGION));
    expect(outcome.regionEnd).toBe(outcome.regionStart + REGION.length);
    expect(outcome.content.startsWith(document.slice(0, outcome.regionStart))).toBe(true);
    expect(differing).toBeGreaterThan(0);
  });

  it("does not touch a second occurrence elsewhere when the anchor is unique to one region", () => {
    // The quoted sentence appears twice, so the model has not said which span
    // it means, and the revision is refused rather than guessing (FR-015b).
    const document = `${REGION}\n\nMiddle.\n\n${REGION}\n`;
    const outcome = applyRevision(document, targeted(document));

    expect(outcome).toMatchObject({ applied: false, reason: "region_ambiguous" });
    expect(outcome).not.toHaveProperty("content");
  });
});
