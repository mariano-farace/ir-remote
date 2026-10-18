import { describe, expect, it } from "vitest";

import { documentRevisionApproval, userApproval } from "@/lib/ai/tools";

/**
 * The anti-clear guard end to end (FR-021, contracts/tool-call.md).
 *
 * The server decides whether a call needs a user's approval *before* the tool
 * executes. Only a change that would remove all of a non-empty script's text
 * is put to the user; that request is resolved by the client through
 * `addToolApprovalResponse`, never by the model. A model's own
 * `confirmedClear` cannot satisfy it.
 */

const DRAFT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

const CLEARING = {
  targetRegion: { anchorText: "Around 1200 BCE, the trade networks fell." },
  expectedText: "Around 1200 BCE, the trade networks fell.",
  replacementText: "",
  isWholesaleDraft: false,
  summary: "Removed the closing sentence.",
};

function approvalFor(
  document: string,
  input: unknown,
  toolCall: { toolName?: string } = {},
) {
  return documentRevisionApproval(document)(
    input as never,
    {
      toolCallId: "call_1",
      messages: [],
      toolName: toolCall.toolName ?? "apply_document_revision",
    } as never,
  );
}

/** A whole-document rewrite of an existing script, without a draft claim. */
const REWRITE = {
  targetRegion: { wholeDocument: true },
  expectedText: DRAFT,
  replacementText: "# A completely different script\n\nWritten from scratch.",
  isWholesaleDraft: false,
  summary: "Rewrote the whole script from scratch.",
};

describe("documentRevisionApproval", () => {
  it("asks the user before a change that would clear a non-empty script", async () => {
    expect(approvalFor(DRAFT, CLEARING)).toEqual(userApproval("clear"));
  });

  it("asks the user even when the model asserts confirmedClear itself", async () => {
    expect(approvalFor(DRAFT, { ...CLEARING, confirmedClear: true })).toEqual(
      userApproval("clear"),
    );
  });

  it.each([
    [
      "a targeted revision",
      DRAFT,
      { ...CLEARING, replacementText: "Around 1200 BCE, the trade networks collapsed." },
    ],
    [
      "a first draft of an empty script",
      "",
      {
        targetRegion: { wholeDocument: true },
        expectedText: "",
        replacementText: "# First Draft",
        isWholesaleDraft: true,
        summary: "Wrote a first draft.",
      },
    ],
    [
      "an empty replacement over an empty document",
      "",
      {
        targetRegion: { wholeDocument: true },
        expectedText: "",
        replacementText: "",
        isWholesaleDraft: true,
        summary: "Nothing to write.",
      },
    ],
    ["a malformed payload", DRAFT, { replacementText: "" }],
  ])("does not put %s to the user", async (_name, document, input) => {
    expect(approvalFor(document, input)).toBe("not-applicable");
  });

  it("decides from the same document the tool itself validates against", () => {
    // The decision is about the server's copy of the text, not anything the
    // client sent: clearing a document that is already empty needs no approval.
    expect(approvalFor(DRAFT, CLEARING)).toEqual(userApproval("clear"));
    expect(approvalFor("   ", CLEARING)).toBe("not-applicable");
  });

  it("asks the user before a full rewrite of a non-empty script (FR-015c)", () => {
    // The second permitted full-document write is an explicit rewrite. It is
    // the user who makes it explicit: the model only proposes it.
    expect(approvalFor(DRAFT, REWRITE)).toEqual(userApproval("rewrite"));
  });

  it("lets the client tell a rewrite's question from the clear guard's", () => {
    // Both are approvals, but they are different questions. The client has to
    // render the right one — a rewrite is legitimate; a clear is the hazard —
    // so the reason the approval carries must say which.
    const clear = approvalFor(DRAFT, CLEARING) as { reason?: string };
    const rewrite = approvalFor(DRAFT, REWRITE) as { reason?: string };

    expect(typeof clear.reason).toBe("string");
    expect(typeof rewrite.reason).toBe("string");
    expect(rewrite.reason).not.toBe(clear.reason);
  });
});
