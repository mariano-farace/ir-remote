"use client";

/**
 * The anti-clear confirmation (FR-021, Principle III Recoverability).
 *
 * A change that would remove all of the script's text is never written on the
 * assistant's word. The store holds the question; this asks it, and only the
 * user's answer moves the document: "Clear the script" runs the revision
 * through the store with their consent, "Cancel" discards it. Both answers go
 * back to the server under the tool call's approval id, so the call is
 * reported as answered rather than left hanging.
 *
 * Nothing here writes text directly; `confirmClear` is the consent, and the
 * store's own `applyProposal` still re-validates the revision against the
 * document in front of the user.
 */

import { useStore } from "zustand";

import type { ToolApprovalResponse } from "@/components/chat/tool-parts";
import { useDocumentStore } from "@/stores/document-store";

export function ClearConfirmation({
  onAnswer,
}: {
  /** `useChat`'s `addToolApprovalResponse`, or a stand-in in tests. */
  readonly onAnswer?: (response: ToolApprovalResponse) => void;
}) {
  const pending = useStore(useDocumentStore, (state) => state.pendingClear);

  if (pending === null || pending.approvalId === "") {
    return null;
  }

  function confirm(): void {
    useDocumentStore.getState().confirmClear();
    onAnswer?.({ id: pending?.approvalId ?? "", approved: true });
  }

  function decline(): void {
    useDocumentStore.getState().declineClear();
    onAnswer?.({ id: pending?.approvalId ?? "", approved: false });
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm clearing the script"
      className="mx-6 mb-4 rounded border border-red-300 bg-red-50 p-4 text-sm"
    >
      <p className="font-semibold">This change would clear the whole script.</p>
      {pending.revision.summary ? (
        <p className="text-foreground-muted mt-1">{pending.revision.summary}</p>
      ) : null}
      <p className="mt-1">
        You can undo the clear from the version history afterwards, but the text on screen
        will be gone.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          className="rounded bg-red-700 px-3 py-1 text-xs text-white"
        >
          Clear the script
        </button>
        <button
          type="button"
          onClick={decline}
          className="rounded border px-3 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
