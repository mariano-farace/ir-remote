import { describe, expect, it } from "vitest";

import {
  applyDocumentRevisionInputSchema,
  createApplyDocumentRevisionTool,
} from "@/lib/ai/tools";

/**
 * The tool is executed on the server (research decision 2). Its `execute`
 * receives the document the server loaded and returns a validated result; a
 * model that asserts `confirmedClear` gets no more than the document rules
 * allow, because the field never survives the schema.
 */

const DRAFT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

const WHOLESALE = {
  targetRegion: { wholeDocument: true },
  expectedText: "",
  replacementText: "# A New Draft\n\nSomething entirely different.",
  isWholesaleDraft: true,
  summary: "Wrote a first draft.",
};

/** What a model actually produces when it tries to redraft a document. */
const REDRAFT_OVER_CONTENT = {
  ...WHOLESALE,
  expectedText: DRAFT,
};

const TARGETED = {
  targetRegion: { anchorText: "Around 1200 BCE, the trade networks fell." },
  expectedText: "Around 1200 BCE, the trade networks fell.",
  replacementText: "Around 1200 BCE, the trade networks collapsed.",
  summary: "Changed the verb.",
};

async function execute(document: string, input: unknown) {
  const tool = createApplyDocumentRevisionTool({ document });

  if (!tool.execute) {
    throw new Error("The revision tool must be server-executed");
  }

  return tool.execute(input as never, {
    toolCallId: "call_1",
    messages: [],
    context: undefined as never,
  });
}

describe("apply_document_revision tool", () => {
  it("tells the model the exact region shapes a call must use", () => {
    // A model that omits `targetRegion` produces a call the SDK refuses before
    // execution, so the description it reads must name both valid forms and the
    // required summary. This is the text the model saw when it stopped omitting
    // the region; a rewrite that drops it silently regresses the first draft.
    const description = createApplyDocumentRevisionTool({ document: "" }).description;

    expect(description).toContain('{"wholeDocument": true}');
    expect(description).toContain("anchorText");
    expect(description).toMatch(/Every call MUST include `targetRegion`/);
    expect(description).toMatch(/`summary`/);
  });

  it("validates its input against the contract's schema", () => {
    const tool = createApplyDocumentRevisionTool({ document: "" });

    expect(tool.inputSchema).toBe(applyDocumentRevisionInputSchema);
  });

  it("returns the applied document for a valid first draft", async () => {
    expect(await execute("", WHOLESALE)).toMatchObject({
      applied: true,
      content: "# A New Draft\n\nSomething entirely different.",
    });
  });

  it("returns the applied document for a targeted revision", async () => {
    expect(await execute(DRAFT, TARGETED)).toMatchObject({
      applied: true,
      content: DRAFT.replace("fell", "collapsed"),
    });
  });

  it("returns the validated revision itself, so the browser can re-check it against its own document", async () => {
    // The browser re-applies the revision through `applyProposal` (Principle III)
    // and must re-validate it: the document may have changed in the browser
    // since the server read it (FR-015b). That needs the revision's address and
    // the text it expected, which only the server can vouch for.
    expect(await execute(DRAFT, TARGETED)).toMatchObject({
      applied: true,
      revision: {
        targetRegion: { type: "anchor", anchorText: TARGETED.targetRegion.anchorText },
        expectedText: TARGETED.expectedText,
        replacementText: TARGETED.replacementText,
        kind: "targeted",
        summary: TARGETED.summary,
      },
    });
  });

  it("refuses a first draft over existing text without mutating it", async () => {
    const outcome = await execute(DRAFT, REDRAFT_OVER_CONTENT);

    expect(outcome).toMatchObject({ applied: false, reason: "wholesale_on_non_empty" });
    expect(outcome).not.toHaveProperty("content");
  });

  it("ignores a model-asserted confirmedClear when the replacement would clear the script", async () => {
    const outcome = await execute(DRAFT, {
      ...WHOLESALE,
      replacementText: "",
      isWholesaleDraft: false,
      targetRegion: { anchorText: "Around 1200 BCE, the trade networks fell." },
      expectedText: "Around 1200 BCE, the trade networks fell.",
      confirmedClear: true,
    });

    expect(outcome).toMatchObject({
      applied: false,
      reason: "clear_requires_confirmation",
    });
    expect(outcome).not.toHaveProperty("content");
  });

  it("reports an invalid payload as a validation error, distinct from a stale one", async () => {
    const outcome = await execute(DRAFT, { ...TARGETED, summary: "x".repeat(201) });

    expect(outcome).toMatchObject({ applied: false, reason: "validation_error" });
  });
});
