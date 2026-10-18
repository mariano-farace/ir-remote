"use client";

/**
 * The rewrite confirmation (FR-015c, second case; Principle III Recoverability).
 *
 * A whole-script rewrite is one of the two full-document writes the contract
 * permits, and only when the user asked for it and confirms it. The store holds
 * the question this component asks; only the user's answer moves the document:
 * confirming runs the revision through the store with their consent, cancelling
 * discards it. Both answers go back to the server under the tool call's
 * approval id, carrying `reason: "rewrite"` — approving a rewrite is never
 * consent to clear the script, which is a separate question (FR-021).
 *
 * The previous version stays recoverable: the confirm path is an ordinary
 * content change, so the text it replaces is recorded as a revision first.
 */

import { useStore } from "zustand";

import type { ToolApprovalResponse } from "@/components/chat/tool-parts";
import { useDocumentStore } from "@/stores/document-store";

export function RewriteConfirmation({
  onAnswer,
}: {
  /** `useChat`'s `addToolApprovalResponse`, or a stand-in in tests. */
  readonly onAnswer?: (response: ToolApprovalResponse) => void;
}) {
  const pending = useStore(useDocumentStore, (state) => state.pendingRewrite);

  if (pending === null || pending.approvalId === "") {
    return null;
  }

  function confirm(): void {
    const approvalId = pending?.approvalId ?? "";

    useDocumentStore.getState().confirmRewrite();
    onAnswer?.({ id: approvalId, approved: true, reason: "rewrite" });
  }

  function decline(): void {
    const approvalId = pending?.approvalId ?? "";

    useDocumentStore.getState().declineRewrite();
    onAnswer?.({ id: approvalId, approved: false, reason: "rewrite" });
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm rewriting the script"
      className="mx-6 mb-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm"
    >
      <p className="font-semibold">This change would rewrite the whole script.</p>
      {pending.summary ? (
        <p className="text-foreground-muted mt-1">{pending.summary}</p>
      ) : null}
      <p className="mt-1">
        The current text is kept as a previous version, so you can undo the rewrite from
        the version history — but what is on screen will be replaced.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          className="rounded bg-amber-700 px-3 py-1 text-xs text-white"
        >
          Rewrite the script
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
