// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClearConfirmation } from "@/components/editor/ClearConfirmation";
import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The user's answer to the clear question as the store and the server see it
 * (FR-021).
 *
 * The store's own effects are covered next door. What is asserted here is the
 * seam the editor owns: the answer is both applied to the document and sent
 * back to the tool call it belongs to, so the server's request is settled
 * rather than left hanging — and a question with no approval id has nothing
 * that could be answered.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";
const CONTENT = "# Draft\n\nAround 1200 BCE, the trade networks fell.";

const CLEARING: PendingRevision = {
  targetRegion: { type: "anchor", anchorText: CONTENT },
  expectedText: CONTENT,
  replacementText: "",
  kind: "targeted",
  summary: "Removed everything.",
};

function ask(approvalId = "approval_1"): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content: CONTENT,
    updatedAt: UPDATED_AT,
  });
  useDocumentStore.getState().requestClearConfirmation({
    toolCallId: "call_clear",
    approvalId,
    revision: CLEARING,
  });
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
});

describe("ClearConfirmation", () => {
  it("declining keeps the text, closes the question, and answers the call", () => {
    const onAnswer = vi.fn();
    ask();
    render(<ClearConfirmation onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel|keep/i }));

    expect(onAnswer).toHaveBeenCalledWith({ id: "approval_1", approved: false });
    expect(useDocumentStore.getState().content).toBe(CONTENT);
    expect(useDocumentStore.getState().pendingClear).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirming clears the script and answers the call", () => {
    const onAnswer = vi.fn();
    ask();
    render(<ClearConfirmation onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole("button", { name: /clear|confirm/i }));

    expect(onAnswer).toHaveBeenCalledWith({ id: "approval_1", approved: true });
    expect(useDocumentStore.getState().content).toBe("");
    expect(useDocumentStore.getState().pendingClear).toBeNull();
  });

  it("shows nothing for a question with no approval id, since nothing could be answered", () => {
    ask("");

    const { container } = render(<ClearConfirmation />);
    act(() => undefined);

    expect(container.innerHTML).toBe("");
  });
});
