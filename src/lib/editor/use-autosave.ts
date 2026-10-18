"use client";

/**
 * Autosave for the active script (FR-004, FR-005).
 *
 * A thin React binding over `createAutosaveScheduler`: the scheduling rules
 * (800 ms trailing debounce, single flight, the post-save dirty re-check) live
 * in `autosave.ts` and are tested there without a renderer. This hook supplies
 * the two things only React can: where the document is read from — the Zustand
 * store, the single source of truth (Principle III) — and persistence against
 * `PUT /api/scripts/{id}/content`.
 *
 * On unmount or when another script is opened, a pending debounce is flushed so
 * the last edit of a session is not lost; `stop()` on the scheduler only cancels
 * a timer that has nothing new to save.
 */

import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import {
  createAutosaveScheduler,
  type AutosaveOutcome,
  type AutosaveScheduler,
} from "@/lib/editor/autosave";
import { offerRecoveryCopy } from "@/lib/editor/recovery-copy";
import { selectIsDirty, useDocumentStore } from "@/stores/document-store";

/**
 * Starts autosave for the script currently open, and keeps it running as the
 * document changes. Mount once, high in the workspace (the editor panel).
 */
export function useAutosave(): void {
  const scriptId = useStore(useDocumentStore, (state) => state.scriptId);
  const dirty = useStore(useDocumentStore, selectIsDirty);
  const scheduler = useRef<AutosaveScheduler | null>(null);

  useEffect(() => {
    if (scriptId === null) {
      return;
    }

    const active = createAutosaveScheduler({
      read: () => {
        const state = useDocumentStore.getState();

        return { content: state.content, persistedContent: state.persistedContent };
      },
      persist: async ({ content }) => {
        const { saveContent } = useDocumentStore.getState();

        await saveContent(content);
      },
      onChange: (outcome: AutosaveOutcome) => {
        const { setSaveState } = useDocumentStore.getState();

        if (outcome.kind === "retrying") {
          setSaveState("retrying");
        } else if (outcome.kind === "failed") {
          // The server never received this text. Keep it in the browser for
          // the next time this script is opened (FR-005b): the editor holds it
          // only until the workspace is closed.
          const state = useDocumentStore.getState();

          offerRecoveryCopy({
            scriptId: state.scriptId ?? scriptId,
            content: state.content,
            savedContent: state.persistedContent,
            savedUpdatedAt: state.updatedAt,
          });
          setSaveState("failed");
        } else {
          setSaveState(outcome.kind);
        }
      },
    });

    scheduler.current = active;

    return () => {
      // Unsaved text is flushed before the scheduler goes away: leaving it for
      // a debounce that will never fire is how an edit silently disappears.
      void active.flush();
      active.stop();

      if (scheduler.current === active) {
        scheduler.current = null;
      }
    };
  }, [scriptId]);

  useEffect(() => {
    if (dirty) {
      scheduler.current?.scheduleEdit();
    }
  }, [dirty]);
}
