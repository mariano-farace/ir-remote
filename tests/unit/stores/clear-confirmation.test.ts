import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

import { acceptedSave } from "../support/persisted-saves";

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

/**
 * The store's half of the anti-clear guard (FR-021): a proposal that would
 * empty the script is a question, and only the user's answer applies it. This
 * is the gate that matters if the server's request is ever bypassed — a
 * replayed part or a document edited while the request was in flight.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const CONTENT = "# Draft\n\nAround 1200 BCE, the trade networks fell.";

/** A targeted edit whose result is an empty document: the anti-clear case. */
const CLEARING: PendingRevision = {
  targetRegion: { type: "anchor", anchorText: CONTENT },
  expectedText: CONTENT,
  replacementText: "",
  kind: "targeted",
  summary: "Removed everything.",
};

function load(content = CONTENT): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content,
    updatedAt: "2026-10-17T10:00:00.000Z",
  });
}

describe("the anti-clear guard in the store", () => {
  beforeEach(() => {
    useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
    saveScriptContent.mockReset();
    saveScriptContent.mockImplementation(
      async (scriptId: string, body?: { content?: string }) =>
        acceptedSave(scriptId, body),
    );
    load();
  });

  afterEach(() => {
    saveScriptContent.mockReset();
  });

  it("refuses a clearing proposal and asks instead of writing", () => {
    const result = useDocumentStore.getState().applyProposal(CLEARING);

    expect(result).toMatchObject({ applied: false, needsClearConfirmation: true });
    expect(useDocumentStore.getState().content).toBe(CONTENT);
  });

  it("applies the same proposal once the user confirms, through the same path", () => {
    useDocumentStore.getState().applyProposal(CLEARING);
    useDocumentStore.getState().requestClearConfirmation({
      toolCallId: "call_1",
      approvalId: "approval_1",
      revision: CLEARING,
    });

    expect(useDocumentStore.getState().confirmClear()).toMatchObject({ applied: true });
    expect(useDocumentStore.getState().content).toBe("");
    expect(useDocumentStore.getState().pendingClear).toBeNull();
    expect(useDocumentStore.getState().saveState).toBe("saving");
  });

  it("writes nothing when the user declines", () => {
    useDocumentStore.getState().requestClearConfirmation({
      toolCallId: "call_1",
      approvalId: "approval_1",
      revision: CLEARING,
    });
    useDocumentStore.getState().declineClear();

    expect(useDocumentStore.getState().content).toBe(CONTENT);
    expect(useDocumentStore.getState().pendingClear).toBeNull();
  });

  it("ignores a second question while one is open", () => {
    const ask = (toolCallId: string) => ({
      toolCallId,
      approvalId: `approval_${toolCallId}`,
      revision: CLEARING,
    });

    useDocumentStore.getState().requestClearConfirmation(ask("first"));
    useDocumentStore.getState().requestClearConfirmation(ask("second"));

    expect(useDocumentStore.getState().pendingClear?.toolCallId).toBe("first");
  });

  it("has nothing to confirm when no question is open", () => {
    expect(useDocumentStore.getState().confirmClear()).toMatchObject({ applied: false });
    expect(useDocumentStore.getState().content).toBe(CONTENT);
  });

  it("drops an open question when another script is opened", () => {
    useDocumentStore.getState().requestClearConfirmation({
      toolCallId: "call_1",
      approvalId: "approval_1",
      revision: CLEARING,
    });
    load("# Another script");

    expect(useDocumentStore.getState().pendingClear).toBeNull();
  });

  it("still applies non-clearing revisions without a confirmation", () => {
    const result = useDocumentStore.getState().applyProposal({
      targetRegion: { type: "anchor", anchorText: "the trade networks fell." },
      expectedText: "the trade networks fell.",
      replacementText: "the trade networks collapsed.",
      kind: "targeted",
      summary: "Changed the verb.",
    });

    expect(result).toMatchObject({ applied: true });
    expect(useDocumentStore.getState().content).toBe(
      "# Draft\n\nAround 1200 BCE, the trade networks collapsed.",
    );
  });
});
