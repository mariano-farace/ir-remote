// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { offerRecoveryCopy, readRecoveryCopy } from "@/lib/editor/recovery-copy";
import { useAutosave } from "@/lib/editor/use-autosave";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The React half of autosave (FR-004, FR-005).
 *
 * The scheduling rules are tested in `autosave.test.ts` against the scheduler
 * alone. What only the hook can get wrong is wired here: that it follows the
 * open script, reports the scheduler's outcomes as visible save states, and
 * saves the last edit before it is torn down rather than leaving it for a
 * debounce that will never fire.
 */

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";

function Host() {
  useAutosave();

  return null;
}

function openScript(content = "First draft."): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content,
    updatedAt: UPDATED_AT,
  });
}

/** Moves past the 800 ms trailing debounce with a real timer. */
async function afterDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

function currentSaveState() {
  return useDocumentStore.getState().saveState;
}

beforeEach(() => {
  localStorage.clear();
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
  saveScriptContent.mockReset();
  saveScriptContent.mockImplementation(
    async (_scriptId: string, body: { content: string }) => {
      // A save the server accepted moves the document's baseline, exactly as
      // the real acknowledgement does.
      useDocumentStore.setState({ persistedContent: body.content });

      return { ok: true, data: { updatedAt: "2026-10-17T10:00:01.000Z" } };
    },
  );
});

afterEach(() => {
  cleanup();
  saveScriptContent.mockReset();
});

describe("useAutosave", () => {
  it("saves nothing while no script is open", async () => {
    render(createElement(Host));

    await afterDebounce();

    expect(saveScriptContent).not.toHaveBeenCalled();
    expect(currentSaveState()).toBe("idle");
  });

  it("saves an edit once it has settled, and reports it saved", async () => {
    render(createElement(Host));
    openScript();

    await act(async () => {
      useDocumentStore.getState().applyProposal("First draft, revised.");
    });
    await afterDebounce();

    expect(saveScriptContent).toHaveBeenCalledTimes(1);
    expect(saveScriptContent).toHaveBeenCalledWith(
      SCRIPT_ID,
      expect.objectContaining({ content: "First draft, revised." }),
    );
    expect(currentSaveState()).toBe("saved");
  });

  it("saves the last edit before it is torn down, rather than dropping it", async () => {
    const view = render(createElement(Host));
    openScript();

    await act(async () => {
      useDocumentStore.getState().applyProposal("An edit that never settled.");
    });

    // The workspace closes before the debounce could fire.
    act(() => {
      view.unmount();
    });
    await afterDebounce();

    expect(saveScriptContent).toHaveBeenCalledWith(
      SCRIPT_ID,
      expect.objectContaining({ content: "An edit that never settled." }),
    );
  });

  it("shows the retrying state while it retries, then the success that followed", async () => {
    vi.useFakeTimers();

    try {
      // The first attempt fails and the retry succeeds.
      saveScriptContent
        .mockImplementationOnce(async () => ({
          ok: false,
          error: { code: "server_error", message: "The server refused the save." },
        }))
        .mockImplementation(async () => ({
          ok: true,
          data: { updatedAt: UPDATED_AT },
        }));
      render(createElement(Host));
      openScript();

      const states: string[] = [];
      const unsubscribe = useDocumentStore.subscribe(() => {
        const { saveState } = useDocumentStore.getState();

        if (states.at(-1) !== saveState) {
          states.push(saveState);
        }
      });

      await act(async () => {
        useDocumentStore.getState().applyProposal("Edit.");
      });
      await vi.advanceTimersByTimeAsync(5_000);
      unsubscribe();

      expect(states).toContain("retrying");
      expect(states.at(-1)).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a save that will not succeed as failed, keeping the text", async () => {
    vi.useFakeTimers();

    try {
      saveScriptContent.mockImplementation(async () => ({
        ok: false,
        error: { code: "server_error", message: "The server refused the save." },
      }));
      render(createElement(Host));
      openScript();

      await act(async () => {
        useDocumentStore.getState().applyProposal("Text that cannot be saved.");
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(currentSaveState()).toBe("failed");
      expect(useDocumentStore.getState().content).toBe("Text that cannot be saved.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the unsaved text when the workspace is left before the save fails", async () => {
    // The user closes the tab while the retries are still running: the
    // teardown's flush is the last save attempt, and its failure is what leaves
    // the copy for the next open (FR-005b).
    saveScriptContent.mockImplementation(async () => ({
      ok: false,
      error: { code: "server_error", message: "The server is down." },
    }));
    const view = render(createElement(Host));
    openScript("What the server has.");

    await act(async () => {
      useDocumentStore.getState().applyProposal("Typed while the save was failing.");
    });

    act(() => {
      view.unmount();
    });

    // The teardown's save attempt settles a moment later — the first retry's
    // delay — and its failure is what the copy records.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toMatchObject({
      content: "Typed while the save was failing.",
      savedContent: "What the server has.",
    });
  });

  it("saves once after a burst of edits, not once per keystroke", async () => {
    render(createElement(Host));
    openScript("First draft.");

    for (const text of ["A", "Ab", "Abc", "Abcd"]) {
      await act(async () => {
        useDocumentStore.getState().applyProposal(text);
      });
    }

    await afterDebounce();

    expect(saveScriptContent).toHaveBeenCalledTimes(1);
    expect(saveScriptContent).toHaveBeenCalledWith(
      SCRIPT_ID,
      expect.objectContaining({ content: "Abcd" }),
    );
    expect(currentSaveState()).toBe("saved");
  });

  it("does not save a script that was only opened", async () => {
    render(createElement(Host));
    openScript("Untouched.");

    await afterDebounce();

    expect(saveScriptContent).not.toHaveBeenCalled();
  });
});
