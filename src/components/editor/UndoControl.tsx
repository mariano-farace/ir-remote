"use client";

/**
 * Undo (FR-019, FR-020, constitution Recoverability).
 *
 * One click restores the most recent version. That is the whole promise: a
 * destructive AI rewrite must be undoable in a single action, so the primary
 * control never opens a menu first. History is the secondary control, for
 * going further back.
 *
 * Both write paths reach the same history because both change content through
 * `applyProposal`, and every save records the content it replaced. The control
 * does not care which path produced a version, and it must not: an undo that
 * covered only AI edits would leave the user's own edits unrecoverable.
 *
 * The restore runs on the server (it is the server that owns the versions) and
 * comes back as an already-written document; the store adopts it without a
 * second save, so the restore is not replayed as an edit.
 */

import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";

import {
  listRevisions,
  restoreRevision,
  type RevisionPreview,
} from "@/lib/http/workspace-api";
import { useDocumentStore } from "@/stores/document-store";

export function UndoControl() {
  const scriptId = useStore(useDocumentStore, (state) => state.scriptId);
  const [versions, setVersions] = useState<readonly RevisionPreview[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (scriptId === null) {
      setVersions([]);

      return;
    }

    const result = await listRevisions(scriptId);

    setVersions(result.ok ? result.data : []);
  }, [scriptId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(versionId: string): Promise<void> {
    if (scriptId === null || restoring) {
      return;
    }

    setRestoring(true);
    setError(null);

    const result = await restoreRevision(scriptId, versionId);

    setRestoring(false);

    if (!result.ok) {
      setError(result.error.message);

      return;
    }

    useDocumentStore
      .getState()
      .adoptPersisted(result.data.content, result.data.updatedAt);
    setShowHistory(false);
    await load();
  }

  if (scriptId === null) {
    return null;
  }

  const newest = versions[0];

  return (
    <div className="flex flex-col gap-2 px-6 pb-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="undo-button"
          disabled={newest === undefined || restoring}
          onClick={() => newest && void restore(newest.id)}
          className="rounded border px-3 py-1 text-xs disabled:opacity-50"
        >
          {restoring ? "Restoring…" : "Undo"}
        </button>
        {versions.length > 1 ? (
          <button
            type="button"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((shown) => !shown)}
            className="text-foreground-muted text-xs"
          >
            History
          </button>
        ) : null}
      </div>

      {showHistory ? (
        <ul aria-label="Version history" role="menu" className="flex flex-col gap-1">
          {versions.map((version) => (
            <li key={version.id} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={restoring}
                onClick={() => void restore(version.id)}
                className="hover:bg-surface-muted w-full truncate rounded px-2 py-1 text-left text-xs"
              >
                <span className="text-foreground-muted">
                  {version.origin === "assistant" ? "Assistant" : "You"} ·{" "}
                  {new Date(version.createdAt).toLocaleTimeString()}
                </span>{" "}
                <span>{version.preview.split("\n")[0] || "(empty)"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
