import { describe, expect, it } from "vitest";

import { describeToolPart } from "@/components/chat/tool-parts";

/**
 * What the chat says about an AI revision call (FR-016, FR-021, FR-022a).
 *
 * The editor, not the chat, carries the script: the chat line exists so a
 * change is never silent — a settled revision says what it changed, a refusal
 * says why, and a call still streaming says nothing rather than guessing.
 */

const APPLIED = {
  type: "tool-apply_document_revision",
  toolCallId: "call_1",
  state: "output-available",
  output: { applied: true, summary: "Cut the intro to two sentences." },
};

describe("describeToolPart", () => {
  it("names what an applied revision changed", () => {
    expect(describeToolPart(APPLIED)).toBe("Cut the intro to two sentences.");
  });

  it("gives the reason a revision was refused", () => {
    expect(
      describeToolPart({
        ...APPLIED,
        output: {
          applied: false,
          message: "The script changed while the request was in flight.",
        },
      }),
    ).toBe("The script changed while the request was in flight.");
  });

  it("shows the error reported for a call that failed", () => {
    expect(
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "output-error",
        errorText: "The model returned output that could not be validated.",
      }),
    ).toBe("The model returned output that could not be validated.");

    expect(
      describeToolPart({ type: "tool-apply_document_revision", state: "output-error" }),
    ).toMatch(/could not be applied/i);
  });

  it("says nothing while the call is still streaming or waiting", () => {
    expect(
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "input-streaming",
      }),
    ).toBeNull();
    expect(
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "input-available",
      }),
    ).toBeNull();
  });

  it("names the question that was actually asked: a rewrite is not a clear", () => {
    // Both questions arrive as `approval-requested`; only the answer differs.
    // Telling the user their rewrite would clear the script is worse than
    // saying nothing: it describes a different, more destructive question.
    const approval = (reason: string) =>
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "approval-requested",
        approval: { id: `approval_${reason}`, reason },
      });

    expect(approval("rewrite")).toMatch(/rewrite the whole script/i);
    expect(approval("rewrite")).not.toMatch(/clear/i);
    expect(approval("clear")).toMatch(/clear the script/i);
  });

  it("says nothing for a settled call whose output is not a revision result", () => {
    expect(
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "output-available",
      }),
    ).toBeNull();
    expect(
      describeToolPart({
        type: "tool-apply_document_revision",
        state: "output-available",
        output: "not a result",
      }),
    ).toBeNull();
  });
});
