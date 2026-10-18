// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoveryOffer } from "@/components/editor/RecoveryOffer";
import { offerRecoveryCopy, readRecoveryCopy } from "@/lib/editor/recovery-copy";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The user's answer to the recovery offer (FR-005b, SC-005).
 *
 * The text in the copy exists nowhere else, so the component's promise is
 * narrow and absolute: it is either in the document once the user chose to
 * restore, or gone once the user chose to discard, and never a stale prompt on
 * the next open.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const OTHER_SCRIPT_ID = "8d1c0f7a-3333-4333-8333-333333333333";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";
const SAVED_CONTENT = "# Draft\n\nSaved.";
const UNSAVED = "# Draft\n\nSaved, and then edited while the save was failing.";

function openScript(content = SAVED_CONTENT, scriptId = SCRIPT_ID): void {
  useDocumentStore.getState().loadScript({
    scriptId,
    conversationId: CONVERSATION_ID,
    content,
    updatedAt: UPDATED_AT,
  });
}

function offer(scriptId = SCRIPT_ID): void {
  offerRecoveryCopy({
    scriptId,
    content: UNSAVED,
    savedContent: SAVED_CONTENT,
    savedUpdatedAt: UPDATED_AT,
  });
}

beforeEach(() => {
  localStorage.clear();
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
});

afterEach(() => {
  cleanup();
});

describe("RecoveryOffer", () => {
  it("is not shown when nothing was left unsaved", () => {
    openScript();

    render(<RecoveryOffer />);

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers the copy when the script is opened with one waiting", () => {
    openScript();
    offer();

    render(<RecoveryOffer />);

    expect(
      screen.getByRole("alertdialog", { name: /restore unsaved text/i }),
    ).toBeTruthy();
  });

  it("restoring puts the text back through the one write path and ends the offer", () => {
    openScript();
    offer();
    render(<RecoveryOffer />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /restore unsaved text/i }));
    });

    const state = useDocumentStore.getState();

    expect(state.content).toBe(UNSAVED);
    // The restored text is a change like any other: unsaved, so autosave sends
    // it and the indicator says so.
    expect(state.saveState).toBe("saving");
    expect(state.persistedContent).toBe(SAVED_CONTENT);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("discarding drops the copy and keeps the saved document", () => {
    openScript();
    offer();
    render(<RecoveryOffer />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    });

    expect(useDocumentStore.getState().content).toBe(SAVED_CONTENT);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("asks again when the user opens another script with its own copy", () => {
    openScript();
    offer();
    render(<RecoveryOffer />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    offer(OTHER_SCRIPT_ID);

    act(() => {
      openScript(SAVED_CONTENT, OTHER_SCRIPT_ID);
    });

    expect(
      screen.getByRole("alertdialog", { name: /restore unsaved text/i }),
    ).toBeTruthy();
  });
});
