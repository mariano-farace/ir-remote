// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScriptList } from "@/components/sidebar/ScriptList";
import type { ScriptSummary } from "@/lib/domain/types";

/**
 * The switch-away warning (T070, FR-005c).
 *
 * Clicking another script while the open one has an unsaved change must not
 * silently drop it. The list asks, and the user chooses: wait for the save
 * (which saves, then opens) or discard the pending change and switch. With
 * nothing unsaved the list opens straight away, and when no save is available
 * to wait for it offers no choice it could not keep.
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

interface Harness {
  readonly unsavedChange?: {
    readonly discard: () => void;
    readonly waitForSave: (targetId: string) => Promise<void>;
  } | null;
  readonly onOpen?: (scriptId: string) => void;
}

function renderList({ unsavedChange = null, onOpen = vi.fn() }: Harness = {}) {
  render(
    createElement(ScriptList, {
      scripts: SCRIPTS,
      activeId: "script-a",
      openingId: null,
      onOpen,
      onDelete: vi.fn(async () => null),
      unsavedChange,
    }),
  );

  return { onOpen, unsavedChange };
}

function clickTitle(title: string): Promise<void> {
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: title }));
  });
}

function clickButton(name: RegExp): Promise<void> {
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

afterEach(() => {
  cleanup();
});

describe("ScriptList switching while a change is unsaved", () => {
  it("opens straight away when there is nothing unsaved", async () => {
    const { onOpen } = renderList();

    await clickTitle("Kodak Years");

    expect(onOpen).toHaveBeenCalledWith("script-b");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before switching, and does nothing until the user chooses", async () => {
    const waitForSave = vi.fn(async () => {});
    const discard = vi.fn();
    const { onOpen } = renderList({ unsavedChange: { discard, waitForSave } });

    await clickTitle("Kodak Years");

    const dialog = screen.getByRole("alertdialog");

    expect(dialog.textContent).toMatch(/unsaved|not been saved/i);
    expect(dialog.textContent).toMatch(/Salt Roads/);
    expect(onOpen).not.toHaveBeenCalled();
    expect(waitForSave).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("waiting for the save saves first and only then opens the clicked script", async () => {
    const order: string[] = [];
    const waitForSave = vi.fn(async () => {
      order.push("save");
    });
    const discard = vi.fn();
    const onOpen = vi.fn(() => order.push("open"));

    renderList({ unsavedChange: { discard, waitForSave }, onOpen });

    await clickTitle("Kodak Years");
    await clickButton(/save and switch|wait for the save/i);

    expect(waitForSave).toHaveBeenCalledWith("script-b");
    expect(discard).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("script-b");
    expect(order).toEqual(["save", "open"]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("discarding drops the pending change and switches without saving", async () => {
    const waitForSave = vi.fn(async () => {});
    const discard = vi.fn();
    const { onOpen } = renderList({ unsavedChange: { discard, waitForSave } });

    await clickTitle("Kodak Years");
    await clickButton(/discard/i);

    expect(discard).toHaveBeenCalled();
    expect(waitForSave).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("script-b");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("staying keeps the open script and its unsaved change", async () => {
    const waitForSave = vi.fn(async () => {});
    const discard = vi.fn();
    const { onOpen, unsavedChange } = renderList({
      unsavedChange: { discard, waitForSave },
    });

    await clickTitle("Kodak Years");
    await clickButton(/stay|cancel/i);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(unsavedChange).not.toBeNull();
  });

  it("switches nothing when the save fails, and says why", async () => {
    const waitForSave = vi.fn(async () => {
      throw new Error("The save failed.");
    });
    const { onOpen } = renderList({ unsavedChange: { discard: vi.fn(), waitForSave } });

    await clickTitle("Kodak Years");
    await clickButton(/save and switch|wait for the save/i);

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(
      /could not be saved|still not saved/i,
    );
  });

  it("offers no choice to wait when no save is available", async () => {
    const { onOpen } = renderList({
      unsavedChange: { discard: vi.fn(), waitForSave: null as never },
    });

    await clickTitle("Kodak Years");

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save and switch|wait/i })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not warn when the clicked row is the script already open", async () => {
    const { onOpen } = renderList({
      unsavedChange: { discard: vi.fn(), waitForSave: vi.fn(async () => {}) },
    });

    await clickTitle("Salt Roads");

    // Reopening the open script would reload it over the unsaved change, so
    // it is not offered at all.
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
