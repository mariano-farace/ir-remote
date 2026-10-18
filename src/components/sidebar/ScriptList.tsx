"use client";

import { useState } from "react";

import type { ApiError } from "@/lib/http/client";
import type { ScriptId, ScriptSummary } from "@/lib/domain/types";

export interface ScriptListProps {
  /** Every script, in the order the sidebar shows them (FR-002). */
  readonly scripts: readonly ScriptSummary[];
  /** The open script, marked as current. */
  readonly activeId: ScriptId | null;
  /** The script whose read is in flight, so its row cannot be clicked twice. */
  readonly openingId: ScriptId | null;
  readonly onOpen: (scriptId: ScriptId) => void;
  /**
   * Deletes the script and everything it owns. Resolves `null` on success, or
   * the failure to show; the list decides nothing about what was deleted.
   */
  readonly onDelete: (scriptId: ScriptId) => Promise<ApiError | null>;
  /**
   * What the open script has not saved yet (FR-005c), or `null` when it is
   * clean. When present, opening another script asks first.
   */
  readonly unsavedChange?: UnsavedChange | null;
}

/** The pending change of the open script, and the two ways out of it. */
export interface UnsavedChange {
  /** Throws away the pending change. */
  readonly discard: () => void;
  /**
   * Saves the pending change; resolves once saved, rejects if it could not be.
   * `null` when no save is available, in which case only discarding is offered.
   */
  readonly waitForSave: ((targetId: ScriptId) => Promise<void>) | null;
}

type SwitchRequest = { readonly scriptId: ScriptId; readonly saved: boolean };

/**
 * The script library: one row per script, and deletion behind a confirmation (T069).
 *
 * Deletion is permanent (spec Out of Scope: no trash), so confirming is a step
 * of its own: the first click only asks, and nothing is sent until the user
 * confirms. The confirmation names the script it would remove, so a misclick
 * cannot silently destroy a different one.
 */
export function ScriptList({
  scripts,
  activeId,
  openingId,
  onOpen,
  onDelete,
  unsavedChange = null,
}: ScriptListProps) {
  const [confirming, setConfirming] = useState<ScriptSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [switching, setSwitching] = useState<SwitchRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTitle =
    scripts.find((script) => script.id === activeId)?.title ?? "this script";

  /** Opens a script, unless the open one has an unsaved change worth asking about. */
  function open(scriptId: ScriptId) {
    if (scriptId === activeId) {
      return;
    }

    if (unsavedChange !== null) {
      setError(null);
      setSwitching({ scriptId, saved: false });
      return;
    }

    onOpen(scriptId);
  }

  async function saveThenSwitch() {
    if (switching === null) {
      return;
    }

    if (unsavedChange === null || unsavedChange.waitForSave === null) {
      return;
    }

    setSaving(true);

    try {
      await unsavedChange.waitForSave(switching.scriptId);
    } catch {
      // The change is still unsaved, so switching would still lose it: stay,
      // and say so rather than leaving the user with a silent no-op.
      setSaving(false);
      setError(
        "The change could not be saved, so the script was not switched. It is still not saved.",
      );
      return;
    }

    setSaving(false);
    setSwitching(null);
    onOpen(switching.scriptId);
  }

  function discardThenSwitch() {
    if (switching === null || unsavedChange === null) {
      return;
    }

    unsavedChange.discard();
    // Once the pending change is gone the parent may still report it for a
    // render, so the switch does not go back through the warning.
    const target = switching.scriptId;
    setSwitching(null);
    onOpen(target);
  }

  async function confirmDelete() {
    if (confirming === null) {
      return;
    }

    setDeleting(true);
    const failure = await onDelete(confirming.id);
    setDeleting(false);

    // Closed either way: on failure the message is shown beside the list, and
    // the user can ask again from the row that is still there.
    setConfirming(null);
    setError(failure ? failure.message : null);
  }

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Script list" className="flex flex-col gap-1">
        {scripts.map((script) => (
          <li key={script.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => open(script.id)}
              aria-current={activeId === script.id ? "true" : undefined}
              disabled={openingId === script.id}
              className="hover:bg-surface-muted aria-[current=true]:bg-surface-muted w-full truncate rounded px-2 py-1 text-left text-sm"
            >
              {script.title}
            </button>
            <button
              type="button"
              aria-label={`Delete ${script.title}`}
              onClick={() => {
                setError(null);
                setConfirming(script);
              }}
              className="text-foreground-muted rounded px-1 text-xs hover:text-red-700"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Delete ${confirming.title}`}
          className="rounded border p-2 text-xs"
        >
          <p>
            Delete &ldquo;{confirming.title}&rdquo;? Its text, its conversation, and its
            version history are removed with it. This cannot be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="rounded bg-red-700 px-2 py-1 text-white disabled:opacity-50"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={deleting}
              className="rounded border px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {switching ? (
        <div
          role="alertdialog"
          aria-label="Unsaved change"
          className="rounded border p-2 text-xs"
        >
          <p>
            &ldquo;{activeTitle}&rdquo; has not been saved yet. Switch to another script
            anyway?
          </p>
          <div className="mt-2 flex gap-2">
            {unsavedChange?.waitForSave ? (
              <button
                type="button"
                onClick={() => void saveThenSwitch()}
                disabled={saving}
                className="text-accent rounded px-2 py-1 disabled:opacity-50"
              >
                Save and switch
              </button>
            ) : null}
            <button
              type="button"
              onClick={discardThenSwitch}
              disabled={saving}
              className="rounded border px-2 py-1 text-red-700 disabled:opacity-50"
            >
              Discard the unsaved change
            </button>
            <button
              type="button"
              onClick={() => setSwitching(null)}
              disabled={saving}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              Stay
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
