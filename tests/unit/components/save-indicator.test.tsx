import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SaveIndicator } from "@/components/editor/SaveIndicator";
import {
  INITIAL_DOCUMENT_STATE,
  useDocumentStore,
  type SaveState,
} from "@/stores/document-store";

/**
 * FR-005: the user can see whether the document is saved, pending, or failed.
 * The indicator must never claim "Saved" for a state that is not saved.
 */

function renderIn(state: SaveState): void {
  useDocumentStore.setState({
    ...INITIAL_DOCUMENT_STATE,
    scriptId: "3f2f1c1e-2222-4222-8222-222222222222",
    saveState: state,
  });
  render(<SaveIndicator />);
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
});

describe("SaveIndicator", () => {
  it("shows nothing when no script is open", () => {
    render(<SaveIndicator />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing before the first change", () => {
    renderIn("idle");

    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["saved", /^Saved$/],
    ["saving", /saving/i],
    ["retrying", /retrying/i],
    ["failed", /not saved/i],
  ] as const)("shows %s", (state, text) => {
    renderIn(state);

    expect(screen.getByRole("status").textContent).toMatch(text);
  });

  it("announces the state politely, so a screen reader hears it without interruption", () => {
    renderIn("failed");

    const status = screen.getByRole("status");

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-label")).toMatch(/not saved/i);
  });

  it("marks a failure distinctly: it is never styled as an ordinary state", () => {
    renderIn("saved");
    const saved = screen.getByRole("status").className;
    cleanup();
    renderIn("failed");
    const failed = screen.getByRole("status").className;

    expect(failed).not.toBe(saved);
    expect(failed).toMatch(/red/);
  });
});
