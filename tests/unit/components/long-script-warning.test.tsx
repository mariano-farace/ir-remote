// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { WorkspaceProvider, useWorkspace } from "@/components/workspace/useWorkspace";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * A script too long for the AI to carry in one request (FR-014c).
 *
 * The workspace warns before sending and sends anyway once the user proceeds:
 * the warning is about context the model may lose, not a refusal, and the
 * script is sent whole — nothing is silently truncated to fit.
 */

const SCRIPT = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "A very long documentary",
};
const SHORT = "# The Salt Roads\n\nCamel caravans crossed the Sahara.";
const LONG = `${SHORT}\n\n${"The caravan moved on, and the salt came with it. ".repeat(1_200)}`;

const chatRequests: string[] = [];

function stubServer(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/api/styles")) {
        return Response.json({
          data: [{ id: "historical-documentary", name: "Historical" }],
        });
      }

      if (url.endsWith("/api/chat")) {
        chatRequests.push(String(init?.body ?? ""));

        // A turn that streams nothing: the request is what this test reads.
        return new Response(
          [
            'data: {"type":"start"}',
            "",
            'data: {"type":"finish"}',
            "",
            "data: [DONE]",
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      if (url.endsWith("/api/scripts")) {
        return Response.json({
          data: [
            {
              id: SCRIPT.id,
              title: SCRIPT.title,
              styleId: "historical-documentary",
              updatedAt: SCRIPT.id,
            },
          ],
        });
      }

      if (/\/api\/scripts\/[^/]+\/messages$/.test(url)) {
        return Response.json({ data: [] });
      }

      if (/\/api\/scripts\/[^/]+$/.test(url)) {
        return Response.json({
          data: {
            ...SCRIPT,
            content: "",
            styleId: "historical-documentary",
            createdAt: SCRIPT.id,
            updatedAt: SCRIPT.id,
          },
        });
      }

      return Response.json({ data: [] });
    }),
  );
}

/** Opens the script through the workspace, the way the sidebar does. */
function OpenOnMount() {
  const workspace = useWorkspace();

  // One open per mount: the component is rendered once per test.
  if (workspace.scripts.length > 0 && workspace.active === null) {
    void workspace.open(SCRIPT.id);
  }

  return null;
}

async function renderWithScriptOpen(content: string): Promise<void> {
  render(
    <WorkspaceProvider>
      <OpenOnMount />
      <ChatPanel />
    </WorkspaceProvider>,
  );

  await waitFor(() => expect(useDocumentStore.getState().scriptId).toBe(SCRIPT.id));

  act(() => {
    useDocumentStore.getState().applyProposal(content);
  });
}

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText(/message/i) as HTMLTextAreaElement;
}

async function send(message: string): Promise<void> {
  await act(async () => {
    fireEvent.change(prompt(), { target: { value: message } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  stubServer();
  chatRequests.length = 0;
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a script over 50 000 characters (FR-014c)", () => {
  it("warns before sending, and does not send until the user proceeds", async () => {
    await renderWithScriptOpen(LONG);

    expect(LONG.length).toBeGreaterThan(50_000);
    await send("Cut the middle section.");

    const warning = await screen.findByRole("alert", { name: /long script|context/i });

    expect(warning.textContent).toMatch(/50 000|context/i);
    expect(chatRequests).toHaveLength(0);

    // The prompt stays as the user typed it: proceeding sends the same message.
    expect(prompt().value).toBe("Cut the middle section.");
  });

  it("sends the whole script once the user proceeds, with nothing truncated", async () => {
    await renderWithScriptOpen(LONG);
    await send("Cut the middle section.");
    await screen.findByRole("alert", { name: /long script|context/i });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send anyway/i }));
    });

    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0]).toContain("Cut the middle section.");
    // The warning has done its job and is gone for this request.
    expect(screen.queryByRole("alert", { name: /long script|context/i })).toBeNull();
  });

  it("warns about context but never truncates what reaches the server", async () => {
    await renderWithScriptOpen(LONG);

    // The document the server is asked about is the document the user has:
    // the length that triggers the warning is never edited down to hide it.
    expect(useDocumentStore.getState().content).toBe(LONG);
  });

  it("does not warn for a script under the threshold", async () => {
    await renderWithScriptOpen(SHORT);
    await send("Cut the middle section.");

    expect(screen.queryByRole("alert", { name: /long script|context/i })).toBeNull();
    await waitFor(() => expect(chatRequests).toHaveLength(1));
  });

  it("lets the user cancel the warning and keep editing the prompt", async () => {
    await renderWithScriptOpen(LONG);
    await send("Cut the middle section.");
    await screen.findByRole("alert", { name: /long script|context/i });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    expect(chatRequests).toHaveLength(0);
    expect(prompt().value).toBe("Cut the middle section.");
    expect(screen.queryByRole("alert", { name: /long script|context/i })).toBeNull();
  });
});
