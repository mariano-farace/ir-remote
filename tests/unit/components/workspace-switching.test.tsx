// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { WorkspaceProvider, useWorkspace } from "@/components/workspace/useWorkspace";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * Switching scripts through the sidebar (T065 regression, SC-008).
 *
 * The unit test of the chat hook opens scripts by calling `open` directly and
 * only looks at the panel afterwards. That cannot see a paint in which the new
 * script is already active while the previous script's turns are still on
 * screen — a user watching the screen would. This test records the panel on
 * every commit, so a pairing of one script with another script's turns is
 * caught whether it lasted one commit or one frame.
 */

const SCRIPTS = {
  A: {
    id: "11111111-1111-4111-8111-111111111111",
    conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Salt Roads",
    turns: [
      { role: "user", content: "Write about the salt roads of the Sahara." },
      { role: "assistant", content: "Wrote a first draft about the salt caravans." },
    ],
  },
  B: {
    id: "22222222-2222-4222-8222-222222222222",
    conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Kodak Years",
    turns: [
      { role: "user", content: "Write about the rise and fall of Kodak." },
      { role: "assistant", content: "Wrote a first draft about Kodak." },
    ],
  },
} as const;

/** What each script's content was last saved as, by content URL. */
const SAVED: Record<string, string> = {};

/** Responds as the handlers would; every `/messages` read waits on `hold`. */
function stubServer(hold: () => Promise<void> | null = () => null) {
  const byId = Object.values(SCRIPTS);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const requestBody = typeof init?.body === "string" ? init.body : null;

      if (url.endsWith("/api/styles")) {
        return Response.json({
          data: [{ id: "historical-documentary", name: "Historical" }],
        });
      }

      if (url === "/api/scripts") {
        return Response.json({
          data: byId.map((script) => ({
            id: script.id,
            title: script.title,
            styleId: null,
            updatedAt: "2026-10-17T09:00:00.000Z",
          })),
        });
      }

      if (method === "PUT" && /\/api\/scripts\/[^/]+\/content$/.test(url)) {
        const saved = JSON.parse(requestBody ?? "{}") as { content?: string };
        SAVED[url] = saved.content ?? "";

        return Response.json({ data: { updatedAt: "2026-10-17T10:00:00.000Z" } });
      }

      const messages = /\/api\/scripts\/([^/]+)\/messages$/.exec(url);

      if (messages) {
        const held = hold();

        if (held) {
          await held;
        }

        const script = byId.find((candidate) => candidate.id === messages[1]);

        return Response.json({
          data: (script?.turns ?? []).map((turn, index) => ({
            id: `${messages[1]}-${index}`,
            ...turn,
            createdAt: `2026-10-17T09:00:0${index}.000Z`,
          })),
        });
      }

      const script = /\/api\/scripts\/([^/]+)$/.exec(url);
      const found = byId.find((candidate) => candidate.id === script?.[1]);

      return Response.json({
        data: {
          id: found?.id,
          title: found?.title,
          content: "",
          styleId: null,
          createdAt: "2026-10-17T09:00:00.000Z",
          updatedAt: "2026-10-17T09:00:00.000Z",
          conversationId: found?.conversationId,
        },
      });
    }),
  );
}

interface Commit {
  /** The conversation the panels were given in this commit (the bound value). */
  readonly conversationId: string;
  /** What the panel's own conversation state held in this commit. */
  readonly messages: string;
}

/**
 * Renders the workspace and records the panels' inputs on every commit.
 *
 * Each commit is what a user could see. The recorder is the last sibling of
 * the panels, so it renders after them, but it reads only stores and props —
 * never the DOM — because the DOM is reconciled by React after these render
 * functions run, and a sibling that reads it would describe the *previous*
 * commit. (React's layout phase can write a store during a commit, which is why
 * the store is not used to say which conversation the panels saw: that is the
 * `conversationId` they were given, read through the provider.)
 *
 * A `MutationObserver` cannot stand in for this: its records within one `act`
 * omit intermediate commits.
 */
function renderWorkspace(): readonly Commit[] {
  const commits: Commit[] = [];

  function Recorder() {
    const { activeConversationId, conversation } = useWorkspace();

    if (activeConversationId !== null) {
      commits.push({
        conversationId: activeConversationId,
        messages: conversation.messages
          .map((message) =>
            message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
          )
          .join("\n"),
      });
    }

    return null;
  }

  render(
    createElement(
      WorkspaceProvider,
      null,
      createElement(Sidebar),
      createElement(ChatPanel),
      createElement(Recorder),
    ),
  );

  return commits;
}

async function findScriptButton(title: string): Promise<HTMLButtonElement> {
  const navigation = screen.getByRole("navigation", { name: /scripts/i });

  // `waitFor` needs a value back, not an assertion: testing-library only
  // retries on a thrown error.
  await waitFor(() =>
    expect(
      [...navigation.querySelectorAll("button")].map((button) => button.textContent),
    ).toContain(title),
  );

  return [...navigation.querySelectorAll("button")].find(
    (button) => button.textContent === title,
  ) as HTMLButtonElement;
}

async function openScript(title: string): Promise<void> {
  await act(async () => {
    // Looked up inside `act`, so the click and the open it starts are one
    // batch: a read that settles immediately must not land between them.
    fireEvent.click(await findScriptButton(title));
    // Let the open's reads settle: each `.then` needs its own microtask turn.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
  });
}

function conversationText(): string {
  return screen.getByRole("region", { name: /conversation/i }).textContent ?? "";
}

beforeEach(() => {
  useDocumentStore.setState(INITIAL_DOCUMENT_STATE);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const key of Object.keys(SAVED)) {
    delete SAVED[key];
  }
});

describe("switching scripts from the sidebar", () => {
  it("never shows the previous script's turns under the new script's name", async () => {
    stubServer();
    const commits = renderWorkspace();

    // The library loads its list on mount, one tick later.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await openScript(SCRIPTS.A.title);
    await waitFor(() => expect(conversationText()).toContain(SCRIPTS.A.turns[0].content));

    // B's history arrives a moment later, as a network read does: the server
    // is swapped for one that holds it until `release`.
    let releaseHistory: () => void = () => {};
    const historyHeld = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    stubServer(() => historyHeld);

    await act(async () => {
      fireEvent.click(await findScriptButton(SCRIPTS.B.title));

      // The document read lands and is rendered inside the same `act`.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The frame right after the bind: B is the active script before its own
    // history has been read, so the panel offers no conversation yet.
    expect(useDocumentStore.getState().scriptId).toBe(SCRIPTS.B.id);
    expect(screen.queryByRole("log", { name: /conversation/i })).toBeNull();

    releaseHistory();
    await waitFor(() => expect(conversationText()).toContain(SCRIPTS.B.turns[0].content));

    // Across every commit, no commit gave a conversation another script's
    // turns.
    const shown = commits.filter(
      (commit) => commit.conversationId === SCRIPTS.B.conversationId,
    );

    expect(shown.length).toBeGreaterThan(0);

    const contaminated = commits
      .map((commit) => ({
        conversationId: commit.conversationId,
        foreign: (Object.values(SCRIPTS) as readonly (typeof SCRIPTS.A)[])
          .filter((script) => script.conversationId !== commit.conversationId)
          .flatMap((script) => script.turns.map((turn) => turn.content))
          .filter((turn) => commit.messages.includes(turn)),
      }))
      .filter((commit) => commit.foreign.length > 0);

    expect(contaminated).toEqual([]);
  });

  it("asks before switching, and switches only after the unsaved text is saved", async () => {
    stubServer();
    renderWorkspace();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await openScript(SCRIPTS.A.title);
    await waitFor(() => expect(conversationText()).toContain(SCRIPTS.A.turns[0].content));

    // An edit the server has not acknowledged.
    await act(async () => {
      useDocumentStore.getState().applyProposal("# Salt Roads\n\nAn unsaved edit.");
    });

    expect(useDocumentStore.getState().content).not.toBe(
      useDocumentStore.getState().persistedContent,
    );

    await act(async () => {
      fireEvent.click(await findScriptButton(SCRIPTS.B.title));
    });

    // Nothing moved yet: the open script is still A.
    expect(useDocumentStore.getState().scriptId).toBe(SCRIPTS.A.id);
    expect(screen.getByRole("alertdialog", { name: /unsaved/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save and switch/i }));

      for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
      }
    });

    await waitFor(() => expect(useDocumentStore.getState().scriptId).toBe(SCRIPTS.B.id));

    // The edit was saved before B was opened, so it is not lost.
    expect(SAVED[`/api/scripts/${SCRIPTS.A.id}/content`]).toBe(
      "# Salt Roads\n\nAn unsaved edit.",
    );
  });
});
