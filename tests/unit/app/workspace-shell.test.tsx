// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceShell from "@/app/page";

/**
 * The three-panel shell (T036).
 *
 * The panels themselves talk to the network and the editor; the shell's job is
 * only to hold them in the three landmark regions the layout names, so a test
 * can see which panel is where without rendering any of their internals.
 */

afterEach(() => {
  cleanup();
});

describe("workspace shell", () => {
  it("has one sidebar, the chat panel, and the editor in the three regions", () => {
    render(<WorkspaceShell />);

    expect(screen.getByRole("navigation", { name: /scripts/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: /conversation/i })).toBeTruthy();
    expect(screen.getByRole("main", { name: /editor/i })).toBeTruthy();
  });

  it("keeps the three panels separate, not nested inside each other", () => {
    render(<WorkspaceShell />);

    const sidebar = screen.getByRole("navigation", { name: /scripts/i });
    const chat = screen.getByRole("region", { name: /conversation/i });
    const editor = screen.getByRole("main", { name: /editor/i });

    expect(sidebar.contains(chat)).toBe(false);
    expect(sidebar.contains(editor)).toBe(false);
    expect(chat.contains(editor)).toBe(false);
  });
});
