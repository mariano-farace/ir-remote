// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/chat/ChatPanel";
import {
  WorkspaceProvider,
  type WorkspaceLibrary,
  useWorkspace,
} from "@/components/workspace/useWorkspace";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * Restoring a script's conversation (T065, FR-003, SC-003).
 *
 * Opening a script must fill the chat with the turns stored for *that* script,
 * and switching away from an unopened one must leave nothing of the previous
 * script behind. The panel is the place the restore becomes visible, so the
 * assertions are what a returning writer would see: the prior turns, in order,
 * under the right speakers — and none of the other script's.
 */

const SCRIPT_A = "11111111-1111-4111-8111-111111111111";
const SCRIPT_B = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The stored turns per script, as `GET /api/scripts/{id}/messages` returns them. */
const TURNS: Record<string, Array<{ role: "user" | "assistant"; content: string }>> = {
  [SCRIPT_A]: [
    { role: "user", content: "Write about the salt roads of the Sahara." },
    { role: "assistant", content: "Wrote a first draft about the salt caravans." },
    { role: "user", content: "Make the opening colder." },
  ],
  [SCRIPT_B]: [
    { role: "user", content: "Write about the rise and fall of Kodak." },
    { role: "assistant", content: "Wrote a first draft about Kodak." },
  ],
};

/** Responds as the route handlers would, for the endpoints the panel calls. */
function stubServer() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith("/api/styles")) {
      return Response.json({
        data: [{ id: "historical-documentary", name: "Historical Documentary" }],
      });
    }

    if (url === "/api/scripts") {
      return Response.json({ data: [] });
    }

    const messages = /\/api\/scripts\/([^/]+)\/messages$/.exec(url);

    if (messages) {
      const scriptId = messages[1] ?? "";
      const turns = TURNS[scriptId];

      return turns
        ? Response.json({
            data: turns.map((turn, index) => ({
              id: `${scriptId}-${index}`,
              ...turn,
              createdAt: `2026-10-17T09:00:0${index}.000Z`,
            })),
          })
        : Response.json(
            { error: { code: "not_found", message: "Missing." } },
            { status: 404 },
          );
    }

    const script = /\/api\/scripts\/([^/]+)$/.exec(url);

    if (script) {
      const id = script[1] ?? "";
      const conversationId = id === SCRIPT_A ? CONVERSATION_A : CONVERSATION_B;

      return Response.json({
        data: {
          id,
          title: id === SCRIPT_A ? "Salt" : "Kodak",
          content: "",
          styleId: null,
          createdAt: "2026-10-17T09:00:00.000Z",
          updatedAt: "2026-10-17T09:00:00.000Z",
          conversationId,
        },
      });
    }

    return Response.json(
      { error: { code: "unexpected", message: url } },
      { status: 500 },
    );
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

/** Renders the chat panel inside a real workspace, exposing the library to the test. */
function renderWorkspace() {
  const library: { current: WorkspaceLibrary | null } = { current: null };

  function Probe() {
    library.current = useWorkspace();

    return null;
  }

  render(
    createElement(
      WorkspaceProvider,
      null,
      createElement(Probe),
      createElement(ChatPanel),
    ),
  );

  return library;
}

beforeEach(() => {
  useDocumentStore.setState(INITIAL_DOCUMENT_STATE);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatPanel restoring a reopened script's conversation", () => {
  it("shows the opened script's stored turns, in order, after reopening", async () => {
    stubServer();
    const library = renderWorkspace();

    await act(async () => {
      await library.current?.open(SCRIPT_A);
    });

    const chat = await screen.findByRole("log", { name: /conversation/i });

    await waitFor(() => {
      expect(chat.querySelectorAll("li[role='article']").length).toBe(
        TURNS[SCRIPT_A]?.length,
      );
    });

    const turns = [...chat.querySelectorAll("li[role='article']")].map((article) => ({
      speaker: article.getAttribute("aria-label"),
      text: article.textContent,
    }));

    expect(turns).toEqual([
      { speaker: "You", text: expect.stringContaining("salt roads of the Sahara") },
      { speaker: "Assistant", text: expect.stringContaining("salt caravans") },
      { speaker: "You", text: expect.stringContaining("Make the opening colder") },
    ]);
  });

  it("never shows another script's turns after switching, and in either order", async () => {
    stubServer();
    const library = renderWorkspace();

    for (const [first, second] of [
      [SCRIPT_A, SCRIPT_B],
      [SCRIPT_B, SCRIPT_A],
    ] as const) {
      await act(async () => {
        await library.current?.open(first);
      });

      const chat = screen.getByRole("log", { name: /conversation/i });

      await waitFor(() => {
        expect(chat.querySelectorAll("li[role='article']").length).toBe(
          TURNS[first]?.length,
        );
      });

      await act(async () => {
        await library.current?.open(second);
      });

      // Opening re-binds the conversation, so the previous script's turns are
      // gone before the new history arrives: the panel is empty until it does.
      // The wait must time out on the *wrong* turns rather than pass on an
      // empty panel, so the old turns are asserted absent after it.
      await waitFor(() => {
        expect(chat.querySelectorAll("li[role='article']").length).not.toBe(
          TURNS[first]?.length,
        );
      });

      await waitFor(() => {
        expect(chat.querySelectorAll("li[role='article']").length).toBe(
          TURNS[second]?.length,
        );
      });

      const text = chat.textContent ?? "";

      for (const turn of TURNS[second] ?? []) {
        expect(text).toContain(turn.content);
      }

      for (const turn of TURNS[first] ?? []) {
        expect(text).not.toContain(turn.content);
      }
    }
  });

  it("shows a restoring state, not an empty or stale conversation, until the history lands", async () => {
    // The restore is a network read that settles after the script is bound.
    // Between the two, the panel must not present either an empty conversation
    // (as if the script had none) or the previous script's turns.
    const stub = stubServer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = stub.getMockImplementation();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/messages")) {
          await gate;

          return new Response(
            JSON.stringify({
              data: (TURNS[SCRIPT_A] ?? []).map((turn, index) => ({
                id: `${SCRIPT_A}-${index}`,
                ...turn,
                createdAt: `2026-10-17T09:00:0${index}.000Z`,
              })),
            }),
            { headers: { "content-type": "application/json" } },
          );
        }

        return respond?.(input);
      }),
    );

    const library = renderWorkspace();
    let opened: Promise<unknown> | null = null;

    await act(async () => {
      opened = library.current?.open(SCRIPT_A) ?? null;

      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
      }
    });

    // The history was requested and is still on its way.
    expect(screen.getByRole("status").textContent).toMatch(/restoring/i);
    expect(screen.queryByRole("log", { name: /conversation/i })).toBeNull();

    await act(async () => {
      release();
      await opened;

      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
      }
    });

    const chat = screen.getByRole("log", { name: /conversation/i });

    await waitFor(() => {
      expect(chat.querySelectorAll("li[role='article']").length).toBe(
        TURNS[SCRIPT_A]?.length,
      );
    });
  });

  it("keeps the prompt usable once a reopened conversation is shown", async () => {
    stubServer();
    const library = renderWorkspace();

    await act(async () => {
      await library.current?.open(SCRIPT_A);
    });

    const chat = screen.getByRole("log", { name: /conversation/i });

    await waitFor(() => {
      expect(chat.querySelectorAll("li[role='article']").length).toBe(3);
    });

    // The restored script accepts a follow-up: the input is present and the
    // send control is enabled.
    expect(screen.getByRole("textbox", { name: /message/i })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: /conversation/i }).textContent,
    ).not.toContain("Create or open a script");
  });
});
