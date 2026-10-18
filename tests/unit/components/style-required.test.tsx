// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { StyleSelector } from "@/components/sidebar/StyleSelector";
import { WorkspaceProvider, useWorkspace } from "@/components/workspace/useWorkspace";

/**
 * The "style required" prompt (T076; spec.md Edge Cases: *Style is never
 * selected*).
 *
 * An AI request that needs a style must prompt the user to choose one rather
 * than quietly producing a generic-tone script. The prompt is a gate, not a
 * warning: while no style is associated, nothing is sent, so nothing reaches
 * the model without a style. Once a style is chosen the same prompt is
 * cleared and the request goes through.
 *
 * The panel runs inside the real workspace library with the HTTP layer stubbed,
 * so the test drives the path a user does and asserts on what they see and on
 * what left the browser.
 */

const SCRIPT = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Untitled register",
  content: "# The Salt Roads\n\nCamel caravans crossed the Sahara.",
};

const chatRequests: unknown[] = [];

beforeEach(() => {
  chatRequests.length = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/styles")) {
        return Response.json({
          data: [
            {
              id: "historical-documentary",
              name: "Historical Documentary",
              description: "",
            },
            { id: "observational", name: "Observational", description: "" },
          ],
        });
      }

      if (url.endsWith("/api/scripts")) {
        return Response.json({
          data: [
            {
              id: SCRIPT.id,
              title: SCRIPT.title,
              styleId: null,
              updatedAt: "2026-10-17T09:00:00.000Z",
            },
          ],
        });
      }

      if (url.endsWith(`/api/scripts/${SCRIPT.id}/messages`)) {
        return Response.json({ data: [] });
      }

      if (method === "PUT" && url.endsWith(`/api/scripts/${SCRIPT.id}/style`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { styleId?: string };

        return Response.json({ data: { styleId: body.styleId } });
      }

      if (url.endsWith(`/api/scripts/${SCRIPT.id}`)) {
        return Response.json({
          data: {
            id: SCRIPT.id,
            title: SCRIPT.title,
            content: SCRIPT.content,
            styleId: null,
            createdAt: "2026-10-17T09:00:00.000Z",
            updatedAt: "2026-10-17T09:00:00.000Z",
            conversationId: SCRIPT.conversationId,
          },
        });
      }

      if (url.endsWith("/api/chat")) {
        chatRequests.push(JSON.parse(String(init?.body ?? "{}")));

        return new Response(
          'data: {"type":"start"}\n\ndata: {"type":"text-start","id":"t1"}\n\n' +
            'data: {"type":"text-delta","id":"t1","delta":"Noted."}\n\n' +
            'data: {"type":"text-end","id":"t1"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }

      return Response.json(
        { error: { code: "not_found", message: `unexpected request: ${url}` } },
        { status: 404 },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opens the style-less script the way the sidebar does, then renders the panels. */
function OpenedWorkspace() {
  const workspace = useWorkspace();
  const { open } = workspace;

  useEffect(() => {
    void open(SCRIPT.id);
  }, [open]);

  return (
    <>
      <StyleSelector
        styleId={workspace.activeStyleId}
        onChoose={
          workspace.active ? (styleId) => void workspace.assignStyle(styleId) : null
        }
      />
      {workspace.active ? <ChatPanel /> : null}
    </>
  );
}

async function sendPrompt(): Promise<void> {
  const input = await screen.findByRole("textbox", { name: /message/i });
  fireEvent.change(input, { target: { value: "Open with a cold, factual sentence." } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
}

describe("ChatPanel — an AI request with no style assigned", () => {
  it("prompts the user to choose a style and sends nothing", async () => {
    render(
      <WorkspaceProvider>
        <OpenedWorkspace />
      </WorkspaceProvider>,
    );

    await screen.findByRole("textbox", { name: /message/i });
    await sendPrompt();

    const prompt = await screen.findByRole("alert", { name: /style/i });

    expect(prompt.textContent).toMatch(/choose a style/i);
    // Nothing was sent: no request exists that the model could have answered.
    expect(chatRequests).toHaveLength(0);
  });

  it("goes through once a style has been chosen, and clears the prompt", async () => {
    render(
      <WorkspaceProvider>
        <OpenedWorkspace />
      </WorkspaceProvider>,
    );

    await screen.findByRole("textbox", { name: /message/i });
    await sendPrompt();
    await screen.findByRole("alert", { name: /style/i });

    const selector = screen.getByRole("combobox", { name: /style/i });
    await waitFor(() =>
      expect(selector.querySelectorAll("option").length).toBeGreaterThan(1),
    );
    fireEvent.change(selector, { target: { value: "observational" } });

    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: /style/i })).toBeNull(),
    );

    await sendPrompt();

    await waitFor(() => expect(chatRequests).toHaveLength(1));
  });
});
