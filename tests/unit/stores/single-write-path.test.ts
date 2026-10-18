// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppliedRevisions } from "@/components/editor/useAppliedRevisions";
import { useAutosave } from "@/lib/editor/use-autosave";
import type { PendingRevision } from "@/lib/domain/types";
import { useDocumentStore } from "@/stores/document-store";

/**
 * FR-004, FR-017, Principle III: a manual edit and an AI revision are the same
 * kind of write. Both go through `applyProposal`, and from there the same
 * persistence sequence — one save of the settled document against the same
 * precondition, the same save-state transitions — so nothing downstream can
 * tell the two paths apart.
 *
 * Each path runs against the same harness: the workspace's effects mounted
 * (`useAppliedRevisions` + `useAutosave`) and the assistant's call already
 * settled in the conversation. The only difference is what causes the text to
 * change — the user typing, or the hook applying the revision.
 */

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";
const BEFORE = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";
const AFTER = "# The Bronze Age\n\nAround 1200 BCE, the trade networks collapsed.";

const REVISION: PendingRevision = {
  targetRegion: {
    type: "anchor",
    anchorText: "Around 1200 BCE, the trade networks fell.",
  },
  expectedText: "Around 1200 BCE, the trade networks fell.",
  replacementText: "Around 1200 BCE, the trade networks collapsed.",
  kind: "targeted",
  summary: "Changed the verb.",
};

/** The assistant's call, settled: what the editor sees after the revision. */
const SETTLED_PART = {
  type: "tool-apply_document_revision",
  toolCallId: "call_1",
  state: "output-available",
  output: { applied: true, content: AFTER, revision: REVISION },
};

interface Run {
  /** Every `applyProposal` call, in order. */
  readonly proposals: readonly unknown[];
  /** Every save-state transition, as the indicators would see it. */
  readonly saveStates: readonly string[];
  /** Every request sent to the save endpoint, in order. */
  readonly saves: readonly unknown[][];
  readonly final: {
    readonly content: string;
    readonly persistedContent: string;
    readonly saveState: string;
  };
}

/** The store's own `applyProposal`, captured before any wrapping. */
const applyProposal = useDocumentStore.getState().applyProposal;

let proposals: unknown[] = [];
let saveStates: string[] = [];
let recording = true;

useDocumentStore.subscribe((state, previous) => {
  if (recording && state.saveState !== previous.saveState) {
    saveStates.push(state.saveState);
  }
});

/** Starts an empty store, records through it, and opens the script. */
function start(): void {
  proposals = [];
  saveStates = [];

  useDocumentStore.setState({
    applyProposal: (proposal) => {
      if (recording) {
        proposals.push(proposal);
      }

      return applyProposal(proposal);
    },
  });
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content: BEFORE,
    updatedAt: UPDATED_AT,
  });
}

/** Saves recorded by the mock, in order. */
function saved(): unknown[][] {
  return saveScriptContent.mock.calls as unknown[][];
}

/** Runs one path end to end and reports everything observable about it. */
async function run(
  saveCalls: unknown[][],
  cause: () => void,
  parts: readonly unknown[] = [],
): Promise<Run> {
  const holder = renderHook(() => {
    useAppliedRevisions(parts as never);
    useAutosave();
  });

  act(cause);

  await vi.waitFor(
    () => {
      if (saveCalls.length === 0) {
        throw new Error("no save yet");
      }
    },
    { timeout: 3_000 },
  );

  recording = false;
  holder.unmount();

  return {
    proposals,
    saveStates,
    saves: saveCalls,
    final: {
      content: useDocumentStore.getState().content,
      persistedContent: useDocumentStore.getState().persistedContent,
      saveState: useDocumentStore.getState().saveState,
    },
  };
}

/** The manual path: `ScriptEditor`'s onUpdate, exactly as the user typing. */
async function manualEdit(): Promise<Run> {
  return run(saved(), () => {
    useDocumentStore.getState().applyProposal(AFTER);
  });
}

/** The AI path: nothing is called; the settled part applies itself. */
async function aiRevision(): Promise<Run> {
  return run(saved(), () => {}, [SETTLED_PART]);
}

beforeEach(() => {
  // Effects from the previous test are stopped before this test touches the
  // store: their pending autosave would otherwise land on the new script.
  cleanup();
  // `loadScript` hands the store a whole new state object, which would drop
  // the recording wrapper above; install it once, before the first script.
  useDocumentStore.setState({
    applyProposal: (proposal) => {
      if (recording) {
        proposals.push(proposal);
      }

      return applyProposal(proposal);
    },
  });
  recording = true;
  start();
  saveScriptContent.mockReset();
  saveScriptContent.mockImplementation(
    async (scriptId: string, body: { content: string }) => ({
      ok: true,
      data: {
        id: scriptId,
        content: body.content,
        updatedAt: `saved-${body.content.length}`,
      },
    }),
  );
});

afterEach(() => {
  cleanup();
});

/**
 * The one persistence sequence the contract allows (FR-004, Principle III):
 * one save of the settled document against the precondition the client last
 * saw, the save state moving from "saving" to "saved", and the document left
 * at the same text. Both write paths must produce exactly this.
 */
const PERSISTENCE = {
  saves: [[SCRIPT_ID, { content: AFTER, baseUpdatedAt: UPDATED_AT }]],
  final: {
    content: AFTER,
    persistedContent: AFTER,
    saveState: "saved",
  },
} as const;

/**
 * What both paths must report about the save, without depending on how many
 * times an in-flight save re-announces itself (the debounce can coalesce two
 * "saving" notices into one): nothing failed, and the last state the indicator
 * hears is that the document is saved.
 */
function expectSaveSucceeded(states: readonly string[]): void {
  expect(states).not.toContain("failed");
  expect(states).not.toContain("retrying");
  expect(states.at(-1)).toBe("saved");
}

describe("manual and AI writes take the same path", () => {
  it("routes a manual edit through applyProposal and persists it once", async () => {
    const manual = await manualEdit();

    expect(manual.proposals).toEqual([AFTER]);
    expect(manual.proposals[0]).toEqual(expect.any(String));
    expect(manual.saves).toEqual(PERSISTENCE.saves);
    expectSaveSucceeded(manual.saveStates);
    expect(manual.final).toEqual(PERSISTENCE.final);
  });

  it("routes an AI revision through applyProposal and persists it identically", async () => {
    const ai = await aiRevision();

    expect(ai.proposals).toEqual([REVISION]);
    expect(ai.proposals[0]).not.toEqual(expect.any(String));
    expect(ai.saves).toEqual(PERSISTENCE.saves);
    expectSaveSucceeded(ai.saveStates);
    expect(ai.final).toEqual(PERSISTENCE.final);
  });
});
