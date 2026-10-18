// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RewriteConfirmation } from "@/components/editor/RewriteConfirmation";
import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The rewrite question in the editor (FR-015c, second case).
 *
 * A full rewrite is permitted only when the user asks for it and confirms it.
 * The question says what will be replaced and that the previous version stays
 * recoverable, and the user's answer is sent back to the call it belongs to —
 * approving a rewrite is never consent to empty the script (FR-021).
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";
const DRAFT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";
const REWRITTEN = "# A different script\n\nWritten from the top.";

const REWRITE: PendingRevision = {
  targetRegion: { type: "whole-document" },
  expectedText: DRAFT,
  replacementText: REWRITTEN,
  kind: "wholesale-rewrite",
  summary: "Rewrote the whole script.",
};

function ask(): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content: DRAFT,
    updatedAt: UPDATED_AT,
  });
  useDocumentStore.getState().requestRewriteConfirmation({
    toolCallId: "call_rewrite",
    approvalId: "approval_rewrite",
    revision: REWRITE,
    summary: REWRITE.summary,
  });
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
});

describe("RewriteConfirmation", () => {
  it("shows nothing while no rewrite is waiting", () => {
    const { container } = render(<RewriteConfirmation />);

    expect(container.innerHTML).toBe("");
  });

  it("says what would be replaced and that the previous version stays recoverable", () => {
    ask();
    render(<RewriteConfirmation />);

    const dialog = screen.getByLabelText(/confirm rewriting the script/i);

    expect(dialog.textContent).toMatch(/whole script/i);
    expect(dialog.textContent).toContain(REWRITE.summary);
    expect(dialog.textContent).toMatch(/previous version|version history|undo/i);
  });

  it("confirming applies the rewrite and answers the call it belongs to", () => {
    const onAnswer = vi.fn();
    ask();
    render(<RewriteConfirmation onAnswer={onAnswer} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /rewrite the script/i }));
    });

    expect(useDocumentStore.getState().content).toBe(REWRITTEN);
    expect(useDocumentStore.getState().pendingRewrite).toBeNull();
    expect(onAnswer).toHaveBeenCalledWith({
      id: "approval_rewrite",
      approved: true,
      reason: "rewrite",
    });
  });

  it("cancelling keeps the script and answers no", () => {
    const onAnswer = vi.fn();
    ask();
    render(<RewriteConfirmation onAnswer={onAnswer} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    expect(useDocumentStore.getState().content).toBe(DRAFT);
    expect(useDocumentStore.getState().pendingRewrite).toBeNull();
    expect(onAnswer).toHaveBeenCalledWith({
      id: "approval_rewrite",
      approved: false,
      reason: "rewrite",
    });
  });
});
