// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScriptList } from "@/components/sidebar/ScriptList";
import type { ApiError } from "@/lib/http/client";
import type { ScriptSummary } from "@/lib/domain/types";

/**
 * Deleting a script from the sidebar (T069, FR-001d).
 *
 * Deletion is permanent (spec Out of Scope: no trash), so the list asks before
 * it acts: nothing is sent until the user confirms, cancelling sends nothing,
 * and after a deletion the workspace is back to the list with no script open.
 * A failed deletion says so and keeps the script in the list.
 */

const SCRIPTS: readonly ScriptSummary[] = [
  {
    id: "script-a",
    title: "Salt Roads",
    styleId: null,
    updatedAt: "2026-10-17T09:00:00.000Z",
  },
  {
    id: "script-b",
    title: "Kodak Years",
    styleId: null,
    updatedAt: "2026-10-17T08:00:00.000Z",
  },
];

function renderList({
  onOpen = () => {},
  onDelete = vi.fn(async () => null),
}: {
  onOpen?: (id: string) => void;
  onDelete?: (id: string) => Promise<ApiError | null>;
} = {}) {
  render(
    createElement(ScriptList, {
      scripts: SCRIPTS,
      activeId: "script-a",
      openingId: null,
      onOpen,
      onDelete,
    }),
  );

  return { onOpen, onDelete };
}

/** The row for a script, found by its title button. */
function row(title: string): HTMLElement {
  return screen.getByRole("button", { name: title }).closest("li") as HTMLElement;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ScriptList deletion", () => {
  it("lists every script in the given order", () => {
    renderList();

    const titles = [
      ...screen.getByRole("list", { name: /script list/i }).querySelectorAll("li"),
    ].map((item) => item.querySelector("button")?.textContent);

    expect(titles).toEqual(["Salt Roads", "Kodak Years"]);
  });

  it("asks for confirmation and sends nothing until the user confirms", async () => {
    const { onDelete } = renderList();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete salt roads/i }));
    });

    const dialog = screen.getByRole("alertdialog");

    expect(dialog.textContent).toMatch(/salt roads/i);
    expect(dialog.textContent).toMatch(/cannot be undone|permanent/i);
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    expect(onDelete).toHaveBeenCalledWith("script-a");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("sends nothing when the user cancels", async () => {
    const { onDelete } = renderList();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete salt roads/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes only the script that was confirmed", async () => {
    const { onDelete } = renderList();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete kodak years/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("script-b");
  });

  it("reports a failed deletion and keeps the script listed", async () => {
    const { onDelete } = renderList({
      onDelete: vi.fn(async () => ({
        code: "invalid_request",
        message: "The script could not be deleted.",
      })),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete salt roads/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    expect(onDelete).toHaveBeenCalledWith("script-a");
    expect(screen.getByRole("alert").textContent).toMatch(/could not be deleted/i);
    expect(screen.getByRole("button", { name: "Salt Roads" })).toBeTruthy();
  });

  it("opens a script when its title is clicked, without asking anything", async () => {
    const onOpen = vi.fn();
    renderList({ onOpen });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kodak Years" }));
    });

    expect(onOpen).toHaveBeenCalledWith("script-b");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("marks the active script", () => {
    renderList();

    expect(
      screen.getByRole("button", { name: "Salt Roads" }).getAttribute("aria-current"),
    ).toBe("true");
    expect(row("Kodak Years").querySelector("button")?.hasAttribute("aria-current")).toBe(
      false,
    );
  });
});
