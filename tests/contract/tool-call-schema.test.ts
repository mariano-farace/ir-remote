import { describe, expect, it } from "vitest";

import { applyDocumentRevisionInputSchema, validateDocumentRevision } from "@/lib/ai/tools";

/**
 * The `apply_document_revision` contract (contracts/tool-call.md), schema half.
 *
 * Principle IV: model output is untrusted input. The schema is the first gate;
 * whether a wholesale draft is *allowed* against a given document is a
 * document-dependent rule tested where it lives (`tests/unit/domain/revision`)
 * and end to end in the chat route. Anything the schema accepts is allowed to
 * reach those checks, so this file asserts both directions.
 */

const VALID_WHOLESALE = {
  targetRegion: { wholeDocument: true },
  expectedText: "",
  replacementText:
    "# The Bronze Age Collapse\n\nAround 1200 BCE, the trade networks fell.",
  isWholesaleDraft: true,
  summary: "Wrote a first draft about the Bronze Age collapse.",
};

const VALID_TARGETED = {
  targetRegion: { anchorText: "Around 1200 BCE, the trade networks fell." },
  expectedText: "Around 1200 BCE, the trade networks fell.",
  replacementText: "Around 1200 BCE, the trade networks collapsed.",
  summary: "Corrected the verb in the opening sentence.",
};

function issuePaths(input: unknown): readonly string[] {
  const result = applyDocumentRevisionInputSchema.safeParse(input);

  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("apply_document_revision input schema", () => {
  describe("accepts conforming payloads", () => {
    it("accepts a valid wholesale draft", () => {
      expect(applyDocumentRevisionInputSchema.safeParse(VALID_WHOLESALE).success).toBe(
        true,
      );
    });

    it("accepts a targeted revision with an anchor", () => {
      expect(applyDocumentRevisionInputSchema.safeParse(VALID_TARGETED).success).toBe(
        true,
      );
    });

    it("treats an omitted isWholesaleDraft as false", () => {
      const parsed = applyDocumentRevisionInputSchema.parse(VALID_TARGETED);

      expect(parsed.isWholesaleDraft).toBe(false);
    });

    it("strips confirmedClear, so the model cannot assert the user's consent", () => {
      const parsed = applyDocumentRevisionInputSchema.parse({
        ...VALID_WHOLESALE,
        confirmedClear: true,
      });

      expect(parsed).not.toHaveProperty("confirmedClear");
    });
  });

  describe("rejects malformed payloads", () => {
    it("rejects a payload missing expectedText", () => {
      const { expectedText: _omitted, ...withoutExpectedText } = VALID_TARGETED;

      expect(issuePaths(withoutExpectedText)).toContain("expectedText");
    });

    it("rejects a summary longer than 200 characters", () => {
      expect(issuePaths({ ...VALID_TARGETED, summary: "a".repeat(201) })).toContain(
        "summary",
      );
    });

    it("accepts a summary of exactly 200 characters", () => {
      expect(issuePaths({ ...VALID_TARGETED, summary: "a".repeat(200) })).toEqual([]);
    });

    it("rejects a region that names neither the whole document nor an anchor", () => {
      expect(
        issuePaths({ ...VALID_TARGETED, targetRegion: {} }).some((path) =>
          path.startsWith("targetRegion"),
        ),
      ).toBe(true);
    });

    it("rejects a region that names both the whole document and an anchor", () => {
      const paths = issuePaths({
        ...VALID_TARGETED,
        targetRegion: {
          wholeDocument: true,
          anchorText: "Around 1200 BCE, the trade networks fell.",
        },
      });

      expect(paths.some((path) => path.startsWith("targetRegion"))).toBe(true);
    });

    it("rejects an anchor shorter than 20 characters, which cannot identify a region", () => {
      expect(
        issuePaths({ ...VALID_TARGETED, targetRegion: { anchorText: "too short" } }),
      ).toContain("targetRegion.anchorText");
    });

    it("rejects a missing replacementText", () => {
      const { replacementText: _omitted, ...withoutReplacement } = VALID_TARGETED;

      expect(issuePaths(withoutReplacement)).toContain("replacementText");
    });
  });
});

describe("apply_document_revision against a document (rejection rule 4)", () => {
  it("accepts a wholesale draft against an empty document", () => {
    expect(validateDocumentRevision(VALID_WHOLESALE, "")).toMatchObject({
      applied: true,
      content: VALID_WHOLESALE.replacementText,
      kind: "first-draft",
    });
  });

  it("rejects a wholesale draft against a non-empty document without writing", () => {
    const existing = "# Existing\n\nThe user already wrote this.";

    expect(
      validateDocumentRevision(
        { ...VALID_WHOLESALE, expectedText: existing },
        existing,
      ),
    ).toMatchObject({
      applied: false,
      reason: "wholesale_on_non_empty",
    });
  });
});
