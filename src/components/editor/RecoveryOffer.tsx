"use client";

/**
 * The offer to restore text a failed save left in the browser (FR-005b,
 * SC-005).
 *
 * When a save failed and the workspace was left, that text exists only here,
 * and this is the user's one chance to decide what happens to it. The question
 * is asked once per open of the script: restoring puts the text back into the
 * document through `applyProposal` — the same write path as any edit, so it is
 * saved and undoable like one — and discarding drops the copy. Either answer
 * ends the offer, so a stale copy is never presented twice.
 *
 * The copy is the user's only copy of that text, so it is released only on
 * success: if the open document cannot take it (another tab saved a different
 * text in the meantime), the user is told and the copy stays where it is.
 */

import { useState } from "react";
import { useStore } from "zustand";

import {
  discardRecoveryCopy,
  readRecoveryCopy,
  takeRecoveryCopy,
} from "@/lib/editor/recovery-copy";
import { useDocumentStore } from "@/stores/document-store";

export function RecoveryOffer() {
  const scriptId = useStore(useDocumentStore, (state) => state.scriptId);
  // Keyed by script, so an answer about one script is not an answer about the
  // next one the user opens — and a new open asks again.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [restoreFailed, setRestoreFailed] = useState<string | null>(null);

  if (scriptId === null || answered.has(scriptId)) {
    return null;
  }

  const copy = readRecoveryCopy({ scriptId });

  if (copy === null || copy.content === "") {
    return null;
  }

  const current = scriptId;

  function confirmRestore(): void {
    const taken = readRecoveryCopy({ scriptId: current });

    if (taken === null) {
      return;
    }

    const result = useDocumentStore.getState().applyProposal(taken.content);

    if (!result.applied) {
      setRestoreFailed(
        `The unsaved text could not be put back: ${result.message ?? "the script has changed since."} It is still kept in this browser.`,
      );

      return;
    }

    // Only now is the copy redundant: the document holds it, and autosave
    // sends it (the restored text is a change, so the indicator says so).
    takeRecoveryCopy({ scriptId: current });
    setAnswered((answers) => new Set(answers).add(current));
  }

  function confirmDiscard(): void {
    discardRecoveryCopy({ scriptId: current });
    setAnswered((answers) => new Set(answers).add(current));
  }

  return (
    <div
      role="alertdialog"
      aria-label="Restore unsaved text"
      className="mx-6 mb-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm"
    >
      <p className="font-semibold">
        A change to this script could not be saved. A copy of the text is kept in this
        browser.
      </p>
      <p className="mt-1">Restore it, or discard it and keep the saved version.</p>
      {restoreFailed ? (
        <p role="alert" className="mt-1 text-red-700">
          {restoreFailed}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={confirmRestore}
          className="text-accent rounded px-2 py-1"
        >
          Restore unsaved text
        </button>
        <button
          type="button"
          onClick={confirmDiscard}
          className="text-foreground-muted rounded px-2 py-1"
        >
          Discard it
        </button>
      </div>
    </div>
  );
}
