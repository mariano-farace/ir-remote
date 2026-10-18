// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceProvider, useWorkspace } from "@/components/workspace/useWorkspace";
import { offerRecoveryCopy, readRecoveryCopy } from "@/lib/editor/recovery-copy";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The script library's decisions (FR-002, FR-003, FR-006, FR-009, FR-001d).
 *
 * The sidebar's happy paths are covered through its rendered UI. What is
 * asserted here is what the panels cannot show: that a reply the user has
 * since moved past never lands, that a failed read is reported rather than
 * mistaken for an empty library, and that deleting the open script leaves
 * nothing of it behind.
 */

const A = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Salt Roads",
  styleId: "historical-documentary" as string | null,
};
const B = {
  id: "22222222-2222-4222-8222-222222222222",
  conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Kodak Years",
  styleId: null as string | null,
};

type Reply = Response | Promise<Response>;

interface Server {
  /** Overrides for one request, keyed `"METHOD /path"`. */
  readonly replies: Map<string, () => Reply>;
}

/** A server answering the workspace's reads and deletes, listable by script. */
function stubServer(): { server: Server; fetchMock: ReturnType<typeof vi.fn> } {
  const server: Server = { replies: new Map() };
  const scripts = [A, B];
  let listable = [...scripts];
  let styles: Record<string, string | null> = { [A.id]: A.styleId, [B.id]: B.styleId };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const override = server.replies.get(key);

    if (override) {
      return override();
    }

    if (url === "/api/scripts" && method === "GET") {
      return Response.json({
        data: listable.map((script) => ({
          id: script.id,
          title: script.title,
          styleId: styles[script.id],
          updatedAt: "2026-10-17T09:00:00.000Z",
        })),
      });
    }

    const messages = /^\/api\/scripts\/([^/]+)\/messages$/.exec(url);

    if (messages) {
      return Response.json({ data: [] });
    }

    const style = /^\/api\/scripts\/([^/]+)\/style$/.exec(url);

    if (style && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { styleId?: string };
      styles = { ...styles, [style[1]]: body.styleId ?? null };

      return Response.json({ data: { styleId: body.styleId } });
    }

    const one = /^\/api\/scripts\/([^/]+)$/.exec(url);
    const found = scripts.find((script) => script.id === one?.[1]);

    if (method === "DELETE") {
      listable = listable.filter((script) => script.id !== found?.id);

      return new Response(null, { status: 204 });
    }

    if (!found) {
      return Response.json(
        { error: { code: "not_found", message: "That script no longer exists." } },
        { status: 404 },
      );
    }

    return Response.json({
      data: {
        id: found.id,
        title: found.title,
        content: "",
        styleId: styles[found.id],
        createdAt: "2026-10-17T09:00:00.000Z",
        updatedAt: "2026-10-17T09:00:00.000Z",
        conversationId: found.conversationId,
      },
    });
  });

  vi.stubGlobal("fetch", fetchMock);

  return { server, fetchMock };
}

/** A deferred reply, for holding one request open while another settles. */
function deferred(): { reply: Promise<Response>; resolve: (value: Response) => void } {
  let resolve: (value: Response) => void = () => {};

  const reply = new Promise<Response>((settle) => {
    resolve = settle;
  });

  return { reply, resolve };
}

function scriptReply(script: typeof A): Response {
  return Response.json({
    data: {
      id: script.id,
      title: script.title,
      content: "",
      styleId: script.styleId,
      createdAt: "2026-10-17T09:00:00.000Z",
      updatedAt: "2026-10-17T09:00:00.000Z",
      conversationId: script.conversationId,
    },
  });
}

function renderLibrary() {
  const latest: { current: ReturnType<typeof useWorkspace> | null } = { current: null };

  function Probe() {
    latest.current = useWorkspace();

    return null;
  }

  render(createElement(WorkspaceProvider, null, createElement(Probe)));

  return latest as { current: ReturnType<typeof useWorkspace> };
}

/** Lets every pending `.then` and the mount's deferred list read land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the script library", () => {
  it("lists every script, most recently modified first by the server", async () => {
    stubServer();
    const library = renderLibrary();

    await settle();

    expect(library.current?.scripts.map((script) => script.title)).toEqual([
      A.title,
      B.title,
    ]);
    expect(library.current?.error).toBeNull();
  });

  it("reports a list that could not be read instead of showing an empty library", async () => {
    const { server } = stubServer();
    server.replies.set("GET /api/scripts", () =>
      Response.json(
        { error: { code: "server_error", message: "The list could not be read." } },
        { status: 500 },
      ),
    );
    const library = renderLibrary();

    await settle();

    expect(library.current?.scripts).toEqual([]);
    expect(library.current?.error).toMatchObject({ code: "server_error" });
  });

  it("binds the script and its conversation together, and clears a read failure", async () => {
    const { server } = stubServer();
    server.replies.set("GET /api/scripts", () =>
      Response.json(
        { error: { code: "server_error", message: "The list could not be read." } },
        { status: 500 },
      ),
    );
    const library = renderLibrary();
    await settle();

    await act(async () => {
      await library.current?.open(A.id);
    });

    expect(library.current?.active).toMatchObject({ id: A.id, title: A.title });
    expect(library.current?.activeConversationId).toBe(A.conversationId);
    expect(library.current?.activeStyleId).toBe(A.styleId);
    expect(library.current?.error).toBeNull();
    expect(useDocumentStore.getState().scriptId).toBe(A.id);
  });

  it("returns the failure of opening a script and leaves the workspace as it was", async () => {
    stubServer();
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    let failure: unknown = null;

    await act(async () => {
      failure = await library.current?.open("99999999-9999-4999-8999-999999999999");
    });

    expect(failure).toMatchObject({ code: "not_found" });
    expect(library.current?.error).toMatchObject({ code: "not_found" });
    // The open script is untouched: a failed open does not close the current one.
    expect(library.current?.active?.id).toBe(A.id);
    expect(useDocumentStore.getState().scriptId).toBe(A.id);
  });

  it("ignores a script read that lands after the user has opened another", async () => {
    const { server } = stubServer();
    const slowA = deferred();
    server.replies.set(`GET /api/scripts/${A.id}`, () => slowA.reply);
    const library = renderLibrary();
    await settle();

    let first: Promise<unknown> | undefined;

    await act(async () => {
      first = library.current?.open(A.id);
    });
    await act(async () => {
      await library.current?.open(B.id);
    });

    // A's reply arrives late: it must not take the screen back from B.
    await act(async () => {
      slowA.resolve(scriptReply(A));

      await first;
    });

    expect(library.current?.active?.id).toBe(B.id);
    expect(library.current?.activeConversationId).toBe(B.conversationId);
    expect(useDocumentStore.getState().scriptId).toBe(B.id);
  });

  it("says the history could not be read while the document still opens", async () => {
    const { server } = stubServer();
    server.replies.set(`GET /api/scripts/${A.id}/messages`, () =>
      Response.json(
        { error: { code: "server_error", message: "The history could not be read." } },
        { status: 500 },
      ),
    );
    const library = renderLibrary();
    await settle();

    await act(async () => {
      await library.current?.open(A.id);
    });

    expect(library.current?.conversationError).toMatchObject({ code: "server_error" });
    expect(library.current?.restoringConversation).toBe(false);
    expect(useDocumentStore.getState().scriptId).toBe(A.id);
  });

  it("assigns one style and reflects it on the open script", async () => {
    stubServer();
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    let failure: unknown = "unset";

    await act(async () => {
      failure = await library.current?.assignStyle("mystery");
    });

    expect(failure).toBeNull();
    expect(library.current?.activeStyleId).toBe("mystery");
    expect(library.current?.scripts.find((script) => script.id === A.id)?.styleId).toBe(
      "mystery",
    );
  });

  it("returns the failure of a refused style and changes nothing", async () => {
    const { server } = stubServer();
    server.replies.set(`PUT /api/scripts/${A.id}/style`, () =>
      Response.json(
        { error: { code: "unknown_style", message: "That style does not exist." } },
        { status: 400 },
      ),
    );
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    let failure: unknown = null;

    await act(async () => {
      failure = await library.current?.assignStyle("not-a-style");
    });

    expect(failure).toMatchObject({ code: "unknown_style" });
    expect(library.current?.activeStyleId).toBe(A.styleId);
  });

  it("does nothing when a style is assigned with no script open", async () => {
    stubServer();
    const library = renderLibrary();
    await settle();

    let failure: unknown = "unset";

    await act(async () => {
      failure = await library.current?.assignStyle("mystery");
    });

    expect(failure).toBeNull();
    expect(library.current?.active).toBeNull();
  });

  it("does not relabel the open script with a reply for one the user has left", async () => {
    const { server } = stubServer();
    const slowA = deferred();
    server.replies.set(`PUT /api/scripts/${A.id}/style`, () => slowA.reply);
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    let assigning: Promise<unknown> | undefined;

    await act(async () => {
      assigning = library.current?.assignStyle("mystery");
    });
    await act(async () => {
      await library.current?.open(B.id);
    });

    await act(async () => {
      slowA.resolve(Response.json({ data: { styleId: "mystery" } }));

      await assigning;
    });

    expect(library.current?.active?.id).toBe(B.id);
    expect(library.current?.activeStyleId).toBe(B.styleId);
  });

  it("deleting the open script leaves nothing of it selected or bound", async () => {
    stubServer();
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    await act(async () => {
      await library.current?.remove(A.id);
    });

    expect(library.current?.active).toBeNull();
    expect(library.current?.activeConversationId).toBeNull();
    expect(library.current?.activeStyleId).toBeNull();
    expect(useDocumentStore.getState().scriptId).toBeNull();
    expect(useDocumentStore.getState().content).toBe("");
    expect(library.current?.scripts.map((script) => script.id)).toEqual([B.id]);
  });

  it("deleting another script leaves the open one exactly as it is", async () => {
    stubServer();
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    await act(async () => {
      await library.current?.remove(B.id);
    });

    expect(library.current?.active?.id).toBe(A.id);
    expect(library.current?.scripts.map((script) => script.id)).toEqual([A.id]);
  });

  it("returns the failure of a refused deletion and keeps the script", async () => {
    const { server } = stubServer();
    server.replies.set(`DELETE /api/scripts/${A.id}`, () =>
      Response.json(
        { error: { code: "server_error", message: "The script was not deleted." } },
        { status: 500 },
      ),
    );
    const library = renderLibrary();
    await settle();
    await act(async () => {
      await library.current?.open(A.id);
    });

    let failure: unknown = null;

    await act(async () => {
      failure = await library.current?.remove(A.id);
    });

    expect(failure).toMatchObject({ code: "server_error" });
    expect(library.current?.active?.id).toBe(A.id);
    expect(library.current?.scripts.map((script) => script.id)).toEqual([A.id, B.id]);
  });

  it("creates a script, opens it, and refreshes the list", async () => {
    const { server } = stubServer();
    server.replies.set("POST /api/scripts", () =>
      Response.json(
        {
          data: {
            id: "33333333-3333-4333-8333-333333333333",
            title: "Lantern Roads",
            content: "",
            styleId: "historical-documentary",
            createdAt: "2026-10-17T11:00:00.000Z",
            conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
        },
        { status: 201 },
      ),
    );
    server.replies.set("GET /api/scripts", () =>
      Response.json({
        data: [{ id: "33333333-3333-4333-8333-333333333333", title: "Lantern Roads" }],
      }),
    );
    const library = renderLibrary();
    await settle();

    await act(async () => {
      await library.current?.create({ title: "Lantern Roads" });
    });

    expect(library.current?.active).toMatchObject({ title: "Lantern Roads" });
    expect(library.current?.activeConversationId).toBe(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(library.current?.scripts.map((script) => script.title)).toEqual([
      "Lantern Roads",
    ]);
  });

  it("returns the failure of a refused creation and opens nothing", async () => {
    const { server } = stubServer();
    server.replies.set("POST /api/scripts", () =>
      Response.json(
        { error: { code: "title_taken", message: "That title is already in use." } },
        { status: 409 },
      ),
    );
    const library = renderLibrary();
    await settle();

    let failure: unknown = null;

    await act(async () => {
      failure = await library.current?.create({ title: "Salt Roads" });
    });

    expect(failure).toMatchObject({ code: "title_taken" });
    expect(library.current?.active).toBeNull();
  });

  describe("a local copy left by a failed save (FR-005b)", () => {
    it("is dropped when the server already has the text it was taken against", async () => {
      stubServer();
      const library = renderLibrary();
      await settle();
      // A's document is empty on this stubbed server, so a copy whose base is
      // the empty text is one the server has caught up with.
      offerRecoveryCopy({ scriptId: A.id, content: "Unsaved text.", savedContent: "" });

      await act(async () => {
        await library.current?.open(A.id);
      });

      expect(readRecoveryCopy({ scriptId: A.id })).toBeNull();
    });

    it("is kept while the server still lacks its text, to be offered on open", async () => {
      stubServer();
      const library = renderLibrary();
      await settle();
      offerRecoveryCopy({
        scriptId: A.id,
        content: "Text the server never received.",
        savedContent: "Some older text the server had.",
      });

      await act(async () => {
        await library.current?.open(A.id);
      });

      expect(readRecoveryCopy({ scriptId: A.id })?.content).toBe(
        "Text the server never received.",
      );
    });
  });
});
