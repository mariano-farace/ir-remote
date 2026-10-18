"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import { useWorkspace } from "@/components/workspace/useWorkspace";
import { useAppliedRevisions } from "@/components/editor/useAppliedRevisions";
import { ClearConfirmation } from "@/components/editor/ClearConfirmation";
import { RecoveryOffer } from "@/components/editor/RecoveryOffer";
import { RewriteConfirmation } from "@/components/editor/RewriteConfirmation";
import { SaveIndicator } from "@/components/editor/SaveIndicator";
import { UndoControl } from "@/components/editor/UndoControl";
import { useAutosave } from "@/lib/editor/use-autosave";
import { editorExtensions, markdownToHtml } from "@/lib/editor/markdown";
import { useDocumentStore } from "@/stores/document-store";

/**
 * The editor panel (T039): a view over the document store, never a second copy
 * of it (Principle III).
 *
 * Two directions, one write path:
 *  - the user types → `applyProposal(markdown)` updates the store;
 *  - the store changes (a revision applied, another script opened) → the
 *    editor is re-rendered from it, with update events suppressed so the echo
 *    cannot loop back through `applyProposal`.
 *
 * AI revisions reach the store through `useAppliedRevisions`, not through
 * `onToolCall`: a tool part is applied exactly once, when it settles.
 */
export function ScriptEditor() {
  const workspace = useWorkspace();
  const scriptId = workspace.active?.id ?? null;

  return (
    <main aria-label="Editor" className="workspace-panel flex flex-col">
      {scriptId !== null ? (
        <EditorSurface key={scriptId} scriptId={scriptId} />
      ) : (
        <p className="text-foreground-muted p-6 text-sm">
          Select a script, or create one, to start writing.
        </p>
      )}
    </main>
  );
}

function EditorSurface({ scriptId }: { readonly scriptId: string }) {
  const content = useStore(useDocumentStore, (state) => state.content);
  const saveState = useStore(useDocumentStore, (state) => state.saveState);
  const { messages, answerApproval } = useWorkspace().conversation;
  const lastStoreContent = useRef(content);

  // Applies each settled revision exactly once, through `applyProposal`.
  useAppliedRevisions(messages.flatMap((message) => message.parts));

  // Saves the document 800 ms after the user stops changing it (FR-004), for
  // a manual edit and an applied revision alike: both land in `content`.
  useAutosave();

  const editor = useEditor(
    {
      extensions: editorExtensions(),
      content: markdownToHtml(content),
      immediatelyRender: false,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": "Script",
          "aria-multiline": "true",
          class: "prose prose-sm max-w-none min-h-96 p-6 outline-none",
        },
      },
      onUpdate: ({ editor: current }) => {
        lastStoreContent.current = current.getMarkdown();
        useDocumentStore.getState().applyProposal(lastStoreContent.current);
      },
    },
    [],
  );

  // Store → editor. Runs for a revision applied while the user was not typing,
  // and for the initial content once the editor exists.
  useEffect(() => {
    if (!editor || content === lastStoreContent.current) {
      return;
    }

    lastStoreContent.current = content;
    editor.commands.setContent(markdownToHtml(content), { emitUpdate: false });
  }, [editor, content]);

  return (
    <div className="flex-1 overflow-y-auto" data-script-id={scriptId}>
      <EditorContent editor={editor} />
      <RecoveryOffer />
      <ClearConfirmation onAnswer={answerApproval} />
      <RewriteConfirmation onAnswer={answerApproval} />
      <SaveIndicator />
      <UndoControl />
      {saveState === "failed" ? (
        <p role="alert" className="px-6 pb-4 text-sm text-red-700">
          This change has not been saved yet.
        </p>
      ) : null}
    </div>
  );
}
