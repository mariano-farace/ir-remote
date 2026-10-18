import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

import { acceptedSave } from "../support/persisted-saves";

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

/**
 * Opening a script replaces the document (T066, FR-003, FR-006, SC-008).
 *
 * The store holds exactly one script's document. Opening another must hand the
 * editor that script's own text, timestamp, and conversation in full — never a
 * merge with, a diff against, or a leftover of the previous one. Switching
 * costs nothing: the empty document of a new script replaces a long one just as
 * completely as the reverse.
 */

const OPENED_AT = "2026-10-17T09:00:00.000Z";

function open(scriptId: string, content: string, conversationId = `conv-${scriptId}`) {
  useDocumentStore.getState().loadScript({
    scriptId,
    conversationId,
    content,
    updatedAt: OPENED_AT,
  });
}

beforeEach(() => {
  useDocumentStore.setState(INITIAL_DOCUMENT_STATE);
  saveScriptContent.mockReset();
  saveScriptContent.mockImplementation(
    async (scriptId: string, body?: { content?: string }) => acceptedSave(scriptId, body),
  );
});

afterEach(() => {
  saveScriptContent.mockReset();
});

describe("loadScript when a script is selected", () => {
  it("replaces the previous script's document entirely, leaving nothing of it", () => {
    open("first", "# Salt Roads\n\nCamel caravans crossed the Sahara.");
    open("second", "# Kodak Years\n\nGeorge Eastman founded the company in 1888.");

    const state = useDocumentStore.getState();

    expect(state.scriptId).toBe("second");
    expect(state.conversationId).toBe("conv-second");
    expect(state.content).toBe(
      "# Kodak Years\n\nGeorge Eastman founded the company in 1888.",
    );
    expect(state.content).not.toContain("salt");
    expect(state.persistedContent).toBe(state.content);
    expect(state.updatedAt).toBe(OPENED_AT);
  });

  it("replaces every other field of the previous script too", () => {
    useDocumentStore.getState().loadScript({
      scriptId: "first",
      conversationId: "conv-first",
      content: "First text.",
      updatedAt: "2026-10-17T08:00:00.000Z",
    });
    useDocumentStore.getState().setSaveState("failed");

    open("second", "Second text.");

    expect(useDocumentStore.getState()).toMatchObject({
      scriptId: "second",
      conversationId: "conv-second",
      content: "Second text.",
      persistedContent: "Second text.",
      updatedAt: OPENED_AT,
      // A freshly loaded document is exactly what the server holds.
      saveState: "saved",
    });
  });

  it("discards an unsaved edit rather than carrying it into the next script", () => {
    open("first", "Saved text.");
    useDocumentStore.getState().applyProposal("Saved text, edited and unsaved.");

    expect(useDocumentStore.getState().content).not.toBe(
      useDocumentStore.getState().persistedContent,
    );

    open("second", "");

    expect(useDocumentStore.getState()).toMatchObject({
      content: "",
      persistedContent: "",
    });
  });

  it("loads an empty script as empty, fabricating nothing", () => {
    open("first", "Something written earlier.");
    open("second", "");

    expect(useDocumentStore.getState().content).toBe("");
    expect(useDocumentStore.getState().persistedContent).toBe("");
  });

  it("switching back and forth alternately shows each script's own text", () => {
    open("first", "First script.");
    open("second", "Second script.");

    for (const [scriptId, content] of [
      ["first", "First script."],
      ["second", "Second script."],
      ["first", "First script."],
    ] as const) {
      open(scriptId, content);

      expect(useDocumentStore.getState().scriptId).toBe(scriptId);
      expect(useDocumentStore.getState().content).toBe(content);
    }
  });

  it("does not alias the caller's string: later store changes leave the input as given", () => {
    const serverDocument = "As the server sent it.";
    open("first", serverDocument);
    useDocumentStore.getState().applyProposal("Edited in the editor.");

    expect(serverDocument).toBe("As the server sent it.");
    expect(useDocumentStore.getState().content).toBe("Edited in the editor.");
  });

  it("clears back to the no-script state when the open script is deleted", () => {
    open("first", "Text of a script about to be deleted.");
    useDocumentStore.getState().setSaveState("failed");

    useDocumentStore.getState().clearScript();

    expect(useDocumentStore.getState()).toMatchObject({
      scriptId: null,
      conversationId: null,
      content: "",
      persistedContent: "",
      updatedAt: null,
      saveState: "idle",
    });
  });
});
