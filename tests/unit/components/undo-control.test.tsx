import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UndoControl } from "@/components/editor/UndoControl";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * Undo (FR-019, FR-020): one action puts the document back to its previous
 * version, whether the last change was typed by the user or applied from an AI
 * revision — both went through `applyProposal`, so both left a version behind.
 *
 * The restore endpoint is the one the app calls; it is mocked here so the
 * component's contract — what it asks for, what it does with the answer — is
 * what is under test.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";

interface Version {
  readonly id: string;
  readonly index: number;
  readonly createdAt: string;
  readonly origin: string;
  readonly preview: string;
}

const VERSIONS: readonly Version[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    index: 2,
    createdAt: "2026-10-17T10:01:00.000Z",
    origin: "assistant",
    preview: "# The Bronze Age",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    index: 1,
    createdAt: "2026-10-17T10:00:00.000Z",
    origin: "user",
    preview: "",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openScript(content = "Current text."): void {
  useDocumentStore.setState({
    ...INITIAL_DOCUMENT_STATE,
    scriptId: SCRIPT_ID,
    conversationId: "20c4c1a0-1111-4111-8111-111111111111",
    content,
    persistedContent: content,
    updatedAt: "2026-10-17T10:02:00.000Z",
    saveState: "saved",
  });
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UndoControl", () => {
  it("offers nothing to undo when the history is empty", async () => {
    openScript();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ data: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The button is rendered disabled rather than absent: its absence would be
    // indistinguishable from "still loading".
    const undo = screen.getByRole("button", { name: /undo/i }) as HTMLButtonElement;

    expect(undo.disabled).toBe(true);
  });

  it("lists the versions, newest first, through the history endpoint", async () => {
    openScript();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ data: VERSIONS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy(),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      `/api/scripts/${SCRIPT_ID}/revisions`,
    );

    fireEvent.click(screen.getByRole("button", { name: /history/i }));

    const items = screen.getAllByRole("menuitem");

    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("# The Bronze Age");
    expect(items[0]?.textContent).toMatch(/assistant/i);
    expect(items[1]?.textContent).toMatch(/you/i);
  });

  it("undoes in one action: restores the newest version and loads its text", async () => {
    openScript("Current text.");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          data: { content: "# The Bronze Age", updatedAt: "2026-10-17T10:03:00.000Z" },
        });
      }

      return jsonResponse({ data: VERSIONS });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy(),
    );

    // One click is the undo: the newest version, not a menu journey.
    fireEvent.click(screen.getByRole("button", { name: /^undo/i }));

    await waitFor(() =>
      expect(useDocumentStore.getState().content).toBe("# The Bronze Age"),
    );

    const restoreCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");

    expect(restoreCall?.[0]).toBe(
      `/api/scripts/${SCRIPT_ID}/revisions/${VERSIONS[0]?.id}/restore`,
    );
    expect(useDocumentStore.getState()).toMatchObject({
      content: "# The Bronze Age",
      persistedContent: "# The Bronze Age",
      updatedAt: "2026-10-17T10:03:00.000Z",
      saveState: "saved",
    });
  });

  it("undoes a manual edit and an AI edit through the same path", async () => {
    // Both origins are in the same list; the control does not branch on which.
    openScript();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({
            data: { content: "# The Bronze Age", updatedAt: "2026-10-17T10:03:00.000Z" },
          })
        : jsonResponse({ data: VERSIONS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    await waitFor(() =>
      expect(useDocumentStore.getState().content).toBe("# The Bronze Age"),
    );
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

    expect(posts).toHaveLength(1);
  });

  it("keeps the document as it is when the restore is refused, and says so", async () => {
    openScript("Current text.");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(
            { error: { code: "not_found", message: "That version no longer exists." } },
            404,
          )
        : jsonResponse({ data: VERSIONS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/no longer exists/i),
    );
    expect(useDocumentStore.getState().content).toBe("Current text.");
  });

  it("does not offer a second restore while one is in flight", async () => {
    openScript();
    let finishRestore: (response: Response) => void = () => {};
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            finishRestore = resolve;
          })
        : Promise.resolve(jsonResponse({ data: VERSIONS })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UndoControl />);
    await waitFor(() =>
      expect((screen.getByTestId("undo-button") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.click(screen.getByTestId("undo-button"));
    await waitFor(() =>
      expect((screen.getByTestId("undo-button") as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );

    // The control now reads "Restoring…"; a second press must do nothing.
    fireEvent.click(screen.getByTestId("undo-button"));
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);

    // Let the restore settle before the test unmounts.
    await act(async () => {
      finishRestore(
        jsonResponse({ data: { content: "Back.", updatedAt: new Date().toISOString() } }),
      );
    });
  });
});
