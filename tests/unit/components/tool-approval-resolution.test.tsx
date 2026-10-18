import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeToolPart } from "@/components/chat/tool-parts";
import { ClearConfirmation } from "@/components/editor/ClearConfirmation";
import { useAppliedRevisions } from "@/components/editor/useAppliedRevisions";
import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The anti-clear guard end to end on the client (FR-021, contracts/tool-call.md).
 *
 * The server asks (`approval-requested`) before it executes a clearing change.
 * The user answers in the workspace — `addToolApprovalResponse` is that answer
 * — and only an approved answer writes. A model's own `confirmedClear` never
 * reaches this point: the schema strips it.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";

const CONTENT = "# Draft\n\nAround 1200 BCE, the trade networks fell.";

/** Exactly what the tool call's summary is; the question repeats it verbatim. */
const SUMMARY = "Removed the closing sentence.";

const CLEARING: PendingRevision = {
  targetRegion: {
    type: "anchor",
    anchorText: "Around 1200 BCE, the trade networks fell.",
  },
  expectedText: "Around 1200 BCE, the trade networks fell.",
  replacementText: "",
  kind: "targeted",
  summary: "Removed the closing sentence.",
};

function requestedPart(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool-apply_document_revision",
    toolCallId: "call_clear",
    state: "approval-requested",
    approval: { id: "approval_1" },
    input: {
      targetRegion: {
        anchorText:
          CLEARING.targetRegion.type === "anchor" ? CLEARING.targetRegion.anchorText : "",
      },
      expectedText: CLEARING.expectedText,
      replacementText: "",
      isWholesaleDraft: false,
      summary: SUMMARY,
      // A model asserting consent gives it nothing.
      confirmedClear: true,
    },
    ...overrides,
  };
}

function approvedResultPart() {
  return {
    type: "tool-apply_document_revision",
    toolCallId: "call_clear",
    state: "output-available",
    approval: { id: "approval_1", approved: true },
    output: { applied: true, content: "", revision: CLEARING },
  };
}

function loadDraft(): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content: CONTENT,
    updatedAt: UPDATED_AT,
  });
}

function run(parts: readonly unknown[]) {
  return renderHook(() => useAppliedRevisions(parts as never));
}

function decline(): void {
  act(() => useDocumentStore.getState().declineClear());
}

describe("a clearing revision the server put to the user", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
    loadDraft();
  });

  it("is described as a question instead of silence", () => {
    expect(describeToolPart(requestedPart())).toMatch(/confirm/i);
  });

  it("says the change was not applied after the user declines", () => {
    expect(
      describeToolPart({
        ...requestedPart(),
        state: "output-denied",
        approval: { id: "approval_1", approved: false },
      }),
    ).toMatch(/not applied/i);
  });

  it("records the question without touching the document", () => {
    run([requestedPart()]);

    expect(useDocumentStore.getState().content).toBe(CONTENT);
    const pending = useDocumentStore.getState().pendingClear;

    expect(pending).not.toBeNull();
    expect(pending?.toolCallId).toBe("call_clear");
    expect(pending?.approvalId).toBe("approval_1");
    expect(pending?.revision.summary).toBe(SUMMARY);
    expect(pending?.revision.replacementText).toBe("");
  });

  it("does not apply the revision while the question is unanswered", () => {
    run([requestedPart(), approvedResultPart()]);

    expect(useDocumentStore.getState().content).toBe(CONTENT);
  });

  it("applies nothing when the user declines", () => {
    run([requestedPart()]);
    decline();

    expect(useDocumentStore.getState().content).toBe(CONTENT);
    expect(useDocumentStore.getState().pendingClear).toBeNull();
  });
});

describe("the confirmation shown in the workspace", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
    loadDraft();
  });

  it("asks with the assistant's summary, and cancelling writes nothing", () => {
    run([requestedPart()]);
    const answered: unknown[] = [];

    render(
      <ClearConfirmation
        onAnswer={(response) => {
          answered.push(response);
        }}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(CLEARING.summary);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(answered).toEqual([{ id: "approval_1", approved: false }]);
    expect(useDocumentStore.getState().content).toBe(CONTENT);
  });

  it("clears the script when the user confirms", () => {
    run([requestedPart()]);
    const answered: unknown[] = [];

    render(
      <ClearConfirmation
        onAnswer={(response) => {
          answered.push(response);
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear the script" }));

    expect(answered).toEqual([{ id: "approval_1", approved: true }]);
    // The revision removes the paragraph it targets; the heading is outside
    // the confirmed region and stays, as region-addressed edits require.
    expect(useDocumentStore.getState().content).toBe("# Draft\n\n");
  });

  it("shows nothing when there is no question", () => {
    render(<ClearConfirmation onAnswer={() => {}} />);

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
