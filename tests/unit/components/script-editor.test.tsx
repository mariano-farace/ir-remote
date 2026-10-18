// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScriptEditor } from "@/components/editor/ScriptEditor";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The editor's two edges with the store (Principle III, FR-003, FR-005).
 *
 * The editor is a view over the store: typing goes in through
 * `applyProposal`, and a change the store made while the user was not typing —
 * a loaded script, an applied AI revision — is pushed into the editor. The
 * TipTap surface itself is replaced by a small recorder here; the real
 * editor's Markdown behaviour is covered by the round-trip contract test.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";

/** The active script the workspace reports; `null` closes the editor panel. */
const workspace = vi.hoisted(() => ({
  active: null as { id: string; title: string } | null,
}));

vi.mock("@/components/workspace/useWorkspace", () => ({
  useWorkspace: () => ({
    active: workspace.active,
    conversation: { messages: [], answerApproval: () => undefined },
  }),
}));

vi.mock("@/lib/editor/use-autosave", () => ({
  useAutosave: () => undefined,
}));

/** The copy of the document the fake TipTap surface currently shows. */
const surface = vi.hoisted(() => ({ content: "<p></p>", writes: [] as string[] }));

vi.mock("@/lib/editor/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/editor/markdown")>();

  return { ...actual, markdownToHtml: (markdown: string) => `<p>${markdown}</p>` };
});

vi.mock("@/components/editor/useAppliedRevisions", () => ({
  useAppliedRevisions: () => undefined,
}));

/** The options the editor surface mounted with, for driving it as the user would. */
const mounted = vi.hoisted(() => ({
  current: null as { onUpdate?: (event: { editor: unknown }) => void } | null,
}));

vi.mock("@tiptap/react", () => ({
  useEditor: (
    options: { content: string; onUpdate?: (event: { editor: unknown }) => void },
    deps: unknown[],
  ) => {
    void deps;
    mounted.current = options;

    return {
      getMarkdown: () => "typed by the user",
      commands: {
        setContent: (html: string, setOptions: { emitUpdate: boolean }) => {
          surface.content = html;
          surface.writes.push(`${html}:${setOptions.emitUpdate}`);
        },
      },
      options,
    };
  },
  EditorContent: () => null,
}));

function openScript(content: string): void {
  workspace.active = { id: SCRIPT_ID, title: "Salt Roads" };
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content,
    updatedAt: UPDATED_AT,
  });
}

beforeEach(() => {
  workspace.active = null;
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
  surface.content = "<p></p>";
  surface.writes = [];
});

afterEach(() => {
  cleanup();
});

describe("ScriptEditor", () => {
  it("asks for a script when none is selected", () => {
    render(<ScriptEditor />);

    expect(screen.getByLabelText(/editor/i).textContent).toMatch(/select a script/i);
  });

  it("pushes a document the store changed into the editor without echoing it back", () => {
    openScript("First draft.");
    render(<ScriptEditor />);
    surface.writes = [];

    const revised = "First draft, revised.";

    act(() => {
      useDocumentStore.setState({
        content: revised,
        persistedContent: revised,
      });
    });

    // Written once, and not emitted as an update: an emitted update would go
    // straight back through `applyProposal` as if the user had typed it.
    expect(surface.writes).toEqual([`<p>${revised}</p>:false`]);
  });

  it("says so when a change has not been saved (FR-005)", () => {
    openScript("First draft.");
    render(<ScriptEditor />);

    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      useDocumentStore.getState().setSaveState("failed");
    });

    expect(screen.getByRole("alert").textContent).toMatch(/not been saved/i);
  });

  it("routes what the user types into the store through applyProposal", () => {
    openScript("First draft.");
    render(<ScriptEditor />);

    act(() => {
      mounted.current?.onUpdate?.({ editor: { getMarkdown: () => "typed by the user" } });
    });

    // The one write path (Principle III): typing lands in the store, and the
    // store now holds an unsaved change rather than being told it was saved.
    expect(useDocumentStore.getState().content).toBe("typed by the user");
    expect(useDocumentStore.getState().saveState).toBe("saving");
  });
});
