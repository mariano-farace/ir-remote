// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/sidebar/Sidebar";
import { WorkspaceProvider } from "@/components/workspace/useWorkspace";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The sidebar's own actions (T037): naming a new script before it exists
 * (FR-001a, FR-001b) and switching the open script's style (FR-009, FR-010).
 *
 * Both route the workspace's answer back to the user: a refused title keeps the
 * prompt open with the rule's message, and a refused style change reverts the
 * selector to what the server actually holds.
 */

const SCRIPT = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Salt Roads",
  styleId: "historical-documentary" as string | null,
};

const STYLES = [
  {
    id: "historical-documentary",
    name: "Historical Documentary",
    description: "Measured.",
  },
  { id: "mystery", name: "Mystery", description: "Withheld." },
];

const CREATED = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Lantern Roads",
  content: "",
  styleId: "historical-documentary",
  createdAt: "2026-10-17T11:00:00.000Z",
  conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

/** Overrides for one request, keyed `"METHOD /path"`, read on every call. */
function stubServer(overrides: Map<string, () => Response>): string[] {
  const posted: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const override = overrides.get(`${method} ${url}`);

      if (override) {
        return override();
      }

      if (url === "/api/styles") {
        return Response.json({ data: STYLES });
      }

      if (url === "/api/scripts" && method === "GET") {
        return Response.json({ data: [SCRIPT] });
      }

      if (url === "/api/scripts" && method === "POST") {
        posted.push(String(init?.body));

        return Response.json({ data: CREATED }, { status: 201 });
      }

      if (url === `/api/scripts/${SCRIPT.id}`) {
        return Response.json({
          data: { ...SCRIPT, createdAt: SCRIPT.id, updatedAt: SCRIPT.id, content: "" },
        });
      }

      if (url === `/api/scripts/${SCRIPT.id}/messages`) {
        return Response.json({ data: [] });
      }

      if (url === `/api/scripts/${SCRIPT.id}/style` && method === "PUT") {
        return Response.json({
          data: { styleId: JSON.parse(String(init?.body)).styleId },
        });
      }

      return Response.json({ data: [] });
    }),
  );

  return posted;
}

function renderSidebar() {
  render(
    <WorkspaceProvider>
      <Sidebar />
    </WorkspaceProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function openScript(): Promise<void> {
  await settle();
  const list = screen.getByRole("navigation", { name: /scripts/i });
  const row = await waitFor(() => {
    const found = [...list.querySelectorAll("button")].find(
      (button) => button.textContent === SCRIPT.title,
    );

    expect(found).toBeTruthy();

    return found as HTMLButtonElement;
  });

  await act(async () => {
    fireEvent.click(row);
  });
}

function titleField(): HTMLInputElement {
  return screen.getByLabelText(/title/i) as HTMLInputElement;
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("creating a script from the sidebar", () => {
  it("asks for a title, sends the one given, and closes the prompt", async () => {
    const posted = stubServer(new Map());
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /create new script/i }));
    fireEvent.change(titleField(), { target: { value: "Lantern Roads" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(screen.queryByLabelText(/title/i)).toBeNull());
    expect(posted).toEqual([JSON.stringify({ title: "Lantern Roads", styleId: null })]);
  });

  it("keeps the prompt open and names the rule when the title is refused", async () => {
    stubServer(
      new Map([
        [
          "POST /api/scripts",
          () =>
            Response.json(
              {
                error: { code: "title_taken", message: "That title is already in use." },
              },
              { status: 409 },
            ),
        ],
      ]),
    );
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /create new script/i }));
    fireEvent.change(titleField(), { target: { value: "Salt Roads" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("already in use"),
    );
    expect(titleField().value).toBe("Salt Roads");
  });

  it("creates nothing when the prompt is cancelled", async () => {
    const posted = stubServer(new Map());
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /create new script/i }));
    fireEvent.change(titleField(), { target: { value: "Lantern Roads" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByLabelText(/title/i)).toBeNull();
    expect(screen.getByRole("button", { name: /create new script/i })).toBeTruthy();
    expect(posted).toEqual([]);
  });
});

describe("changing the open script's style from the sidebar", () => {
  it("persists the choice and shows it as the active style", async () => {
    stubServer(new Map());
    renderSidebar();
    await openScript();

    const select = (await screen.findByRole("combobox", {
      name: /style/i,
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    await act(async () => {
      fireEvent.change(select, { target: { value: "mystery" } });
    });

    await waitFor(() => expect(select.value).toBe("mystery"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reverts the selector and says why when the server refuses the style", async () => {
    stubServer(
      new Map([
        [
          `PUT /api/scripts/${SCRIPT.id}/style`,
          () =>
            Response.json(
              { error: { code: "unknown_style", message: "That style does not exist." } },
              { status: 400 },
            ),
        ],
      ]),
    );
    renderSidebar();
    await openScript();

    const select = (await screen.findByRole("combobox", {
      name: /style/i,
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("historical-documentary"));
    await act(async () => {
      fireEvent.change(select, { target: { value: "mystery" } });
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/does not exist/i),
    );
    expect(select.value).toBe("historical-documentary");
  });
});
