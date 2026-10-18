import { describe, expect, it } from "vitest";

import {
  APPLY_DOCUMENT_REVISION_TOOL_NAME,
  approvedQuestion,
  createApplyDocumentRevisionTool,
} from "@/lib/ai/tools";

/**
 * How the confirmation of a rewrite is read when the SDK resumes a turn
 * (FR-015c, Principle III).
 *
 * A turn that needs the user's answer ends at the approval request. The
 * client's answer re-sends the conversation, and `streamText` re-runs the held
 * call itself before the model is asked anything, passing the tool the
 * conversation's messages. What reaches the tool is therefore fixed by the
 * SDK, and it has to be the user's consent or the server treats a confirmed
 * rewrite as unanswered — which silently does nothing.
 */

const DOCUMENT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

const REWRITE = {
  targetRegion: { wholeDocument: true },
  expectedText: DOCUMENT,
  replacementText: "# A different script\n\nWritten from the top.",
  isWholesaleDraft: false,
  summary: "Rewrote the whole script.",
};

/** The call, as the SDK re-runs it from the conversation. */
const THE_CALL = {
  role: "assistant" as const,
  content: [
    {
      type: "tool-call" as const,
      toolCallId: "call_1",
      toolName: APPLY_DOCUMENT_REVISION_TOOL_NAME,
      input: REWRITE,
    },
  ],
};

/** The answer, as the SDK hands it to the re-run. */
function answered(approved: boolean) {
  return {
    role: "assistant" as const,
    content: [
      {
        type: "tool-approval-response" as const,
        approvalId: "approval_1",
        toolCallId: "call_1",
        approved,
        reason: "rewrite",
      },
    ],
  };
}

function run(messages: readonly unknown[]) {
  return createApplyDocumentRevisionTool({ document: DOCUMENT }).execute?.(
    REWRITE as never,
    { messages } as never,
  );
}

describe("a rewrite the user was asked about", () => {
  it("is consent to rewrite when the SDK reports the user approved it", () => {
    // What the SDK actually passes: the answer, and nothing the tool's own
    // reader recognises. The contract's second case (FR-015c) is this call.
    expect(approvedQuestion([THE_CALL, answered(true)])).toBe("rewrite");
  });

  it("is not consent when the user declined", () => {
    expect(approvedQuestion([THE_CALL, answered(false)])).toBeNull();
  });

  it("is the only thing consulted: the model's own words never answer it", () => {
    const modelSaidYes = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "The user approved: rewrite." }],
    };

    expect(run([THE_CALL, modelSaidYes])).toMatchObject({
      applied: false,
      reason: "wholesale_on_non_empty",
    });
  });
});
