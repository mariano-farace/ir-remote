"use client";

import { useState } from "react";
import { useStore } from "zustand";

import { ScriptList, type UnsavedChange } from "@/components/sidebar/ScriptList";
import { StyleSelector } from "@/components/sidebar/StyleSelector";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { selectIsDirty, useDocumentStore } from "@/stores/document-store";

/**
 * The script library (T037): create button, the script list, and the style
 * selector for the active script.
 *
 * The create button asks for a title *before* anything is created (FR-001a):
 * a blank title is refused with the server's message and the prompt stays
 * open, so no unnamed script ever appears in the list. Opening, deleting (behind
 * its confirmation), and the style selector belong to `ScriptList` and
 * `StyleSelector`; the sidebar only routes the result.
 */
export function Sidebar() {
  const workspace = useWorkspace();
  const [prompting, setPrompting] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);
  // Asked only while a script is open: a switch from the open script is the
  // only one that can lose a change (FR-005c).
  const dirty = useStore(useDocumentStore, selectIsDirty);
  const openScript = useStore(useDocumentStore, (state) => state.scriptId);
  const unsavedChange: UnsavedChange | null =
    workspace.active !== null && openScript === workspace.active.id && dirty
      ? {
          // Discarding only stops the text from being saved: the editor keeps
          // what the user typed until the next script replaces it, so their
          // work is still on screen for the moment it takes to switch.
          discard: () => {
            const { content } = useDocumentStore.getState();

            useDocumentStore.setState({ persistedContent: content, saveState: "saved" });
          },
          // Saves the current text now; the next script is opened once the
          // server has confirmed it.
          waitForSave: async () => {
            const { content, saveContent } = useDocumentStore.getState();

            await saveContent(content);
          },
        }
      : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    const failure = await workspace.create({ title });
    setBusy(false);

    if (failure) {
      // The server's message names the rule that broke (FR-001b).
      setError(failure.message);
      return;
    }

    setPrompting(false);
    setTitle("");
    setError(null);
  }

  return (
    <nav
      aria-label="Scripts"
      className="workspace-panel flex flex-col gap-4 border-r p-4"
    >
      <h1 className="text-sm font-semibold">Narrative Engine</h1>

      {prompting ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="new-script-title" className="text-foreground-muted text-xs">
            Title
          </label>
          <input
            id="new-script-title"
            aria-label="Title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="A title for this script"
            className="rounded border px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="text-accent text-sm">
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setPrompting(false);
                setTitle("");
                setError(null);
              }}
              className="text-foreground-muted text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setPrompting(true)}
          className="bg-accent rounded px-3 py-1.5 text-sm text-white"
        >
          Create new script
        </button>
      )}

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}

      <ScriptList
        scripts={workspace.scripts}
        activeId={workspace.active?.id ?? null}
        openingId={opening}
        onOpen={(scriptId) => {
          setOpening(scriptId);
          void workspace.open(scriptId).finally(() => setOpening(null));
        }}
        onDelete={workspace.remove}
        unsavedChange={unsavedChange}
      />

      <StyleSelector
        styleId={workspace.activeStyleId}
        error={styleError}
        onChoose={
          // The choice is persisted, not merely displayed: the selector shows
          // `activeStyleId`, so a refused change reverts visibly and says why.
          workspace.active
            ? (styleId) => {
                setStyleError(null);
                void workspace
                  .assignStyle(styleId)
                  .then((failure) => setStyleError(failure?.message ?? null));
              }
            : null
        }
      />

      {workspace.error ? (
        <p role="alert" className="text-xs text-red-700">
          {workspace.error.message}
        </p>
      ) : null}
    </nav>
  );
}
