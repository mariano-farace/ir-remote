"use client";

/**
 * Whether the document is saved (FR-005).
 *
 * The indicator is a promise to the user, so it has exactly the states the
 * document can be in and no optimistic ones: it says "Saved" only after the
 * server acknowledged the text, shows "Retrying" while a failed save is being
 * attempted again, and shows "Not saved" — never a spinner that hides a
 * failure — once saving has given up.
 *
 * It reads the store directly: the save state is set by the autosave scheduler
 * (the only writer), and threading it through props would let a panel show a
 * stale copy of a value that must be right.
 */

import { useStore } from "zustand";

import { useDocumentStore, type SaveState } from "@/stores/document-store";

interface Copy {
  readonly text: string;
  readonly className: string;
}

const COPY: Record<Exclude<SaveState, "idle">, Copy> = {
  saved: { text: "Saved", className: "text-foreground-muted" },
  saving: { text: "Saving…", className: "text-foreground-muted" },
  retrying: { text: "Retrying save…", className: "text-foreground-muted" },
  failed: { text: "Not saved", className: "text-red-700" },
};

export function SaveIndicator() {
  const saveState = useStore(useDocumentStore, (state) => state.saveState);
  const scriptId = useStore(useDocumentStore, (state) => state.scriptId);

  // Nothing to report with no script open (or before the first change).
  if (scriptId === null || saveState === "idle") {
    return null;
  }

  const copy = COPY[saveState];

  return (
    <p
      role="status"
      aria-live="polite"
      aria-label={`Save status: ${copy.text}`}
      className={`px-6 pb-4 text-xs ${copy.className}`}
    >
      {copy.text}
    </p>
  );
}
