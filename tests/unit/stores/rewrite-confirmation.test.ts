import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acceptedSave } from "../support/persisted-saves";
import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

/**
 * The store's half of the rewrite question (FR-015c, second case).
 *
 * A full rewrite of a non-empty script is permitted only when the user asks
 * for it and confirms it. The server asks; the store holds the question and
 * writes nothing until the user answers, and the answer goes through the same
 * `applyProposal` path as every other change.
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

function load(): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content: DRAFT,
    updatedAt: UPDATED_AT,
  });
}

function ask(): void {
  useDocumentStore.getState().requestRewriteConfirmation({
    toolCallId: "call_rewrite",
    approvalId: "approval_1",
    revision: REWRITE,
    summary: REWRITE.summary,
  });
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
  saveScriptContent.mockReset();
  saveScriptContent.mockImplementation(
    async (scriptId: string, body?: { content?: string }) => acceptedSave(scriptId, body),
  );
});

afterEach(() => {
  saveScriptContent.mockReset();
});

describe("a rewrite the server asked the user about", () => {
  it("records the question without touching the document", () => {
    load();
    ask();

    const state = useDocumentStore.getState();

    expect(state.content).toBe(DRAFT);
    expect(state.pendingRewrite).toMatchObject({
      toolCallId: "call_rewrite",
      approvalId: "approval_1",
      summary: "Rewrote the whole script.",
    });
  });

  it("writes nothing on its own: an unconfirmed rewrite is refused", () => {
    load();

    const result = useDocumentStore.getState().applyProposal(REWRITE);

    expect(result.applied).toBe(false);
    expect(useDocumentStore.getState().content).toBe(DRAFT);
  });

  it("applies the rewrite once the user confirms, through the same write path", () => {
    load();
    ask();

    const result = useDocumentStore.getState().confirmRewrite();

    const state = useDocumentStore.getState();

    expect(result.applied).toBe(true);
    expect(state.content).toBe(REWRITTEN);
    // A change like any other: unsaved, so autosave sends it and a revision of
    // the prior text is written first (FR-015, FR-020).
    expect(state.saveState).toBe("saving");
    expect(state.persistedContent).toBe(DRAFT);
    expect(state.pendingRewrite).toBeNull();
  });

  it("keeps the previous version recoverable: the rewrite is a normal content change", async () => {
    load();
    ask();
    useDocumentStore.getState().confirmRewrite();

    await useDocumentStore.getState().saveContent(REWRITTEN);

    // The save is the ordinary content save, against the base the client had:
    // the server records the prior text as a revision before storing this one.
    expect(saveScriptContent).toHaveBeenCalledWith(SCRIPT_ID, {
      content: REWRITTEN,
      baseUpdatedAt: UPDATED_AT,
    });
  });

  it("writes nothing when the user declines, and closes the question", () => {
    load();
    ask();

    useDocumentStore.getState().declineRewrite();

    expect(useDocumentStore.getState().content).toBe(DRAFT);
    expect(useDocumentStore.getState().pendingRewrite).toBeNull();
  });

  it("refuses a confirmation when no rewrite is waiting", () => {
    load();

    expect(useDocumentStore.getState().confirmRewrite()).toMatchObject({
      applied: false,
    });
    expect(useDocumentStore.getState().content).toBe(DRAFT);
  });

  it("keeps the first question when a replayed stream asks twice", () => {
    load();
    ask();
    useDocumentStore.getState().requestRewriteConfirmation({
      toolCallId: "call_replay",
      approvalId: "approval_2",
      revision: REWRITE,
      summary: REWRITE.summary,
    });

    expect(useDocumentStore.getState().pendingRewrite?.approvalId).toBe("approval_1");
  });

  it("is a different question from the clear guard, and answering one leaves the other alone", () => {
    load();
    useDocumentStore.getState().requestClearConfirmation({
      toolCallId: "call_clear",
      approvalId: "approval_clear",
      revision: { ...REWRITE, replacementText: "" },
    });
    ask();

    useDocumentStore.getState().declineRewrite();

    expect(useDocumentStore.getState().pendingClear?.toolCallId).toBe("call_clear");
    expect(useDocumentStore.getState().content).toBe(DRAFT);
  });
});
