// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppliedRevisions } from "@/components/editor/useAppliedRevisions";
import type { PendingRevision } from "@/lib/domain/types";
import { INITIAL_DOCUMENT_STATE, useDocumentStore } from "@/stores/document-store";

/**
 * The editor applies an AI revision when its tool part reaches
 * `output-available`, exactly once, through `applyProposal` (T039,
 * Principle III). An `onToolCall` handler would apply it twice; this hook is the
 * only place that turns a streamed tool part into a document change.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";

const DRAFT: PendingRevision = {
  targetRegion: { type: "whole-document" },
  expectedText: "",
  replacementText: "# The Bronze Age\n\nThe networks fell.",
  kind: "first-draft",
  summary: "Wrote a first draft.",
};

/** What the server returns: the validated revision plus its applied result. */
function appliedOutput(revision: PendingRevision) {
  return {
    applied: true,
    content: revision.replacementText,
    kind: revision.kind,
    regionStart: 0,
    regionEnd: 0,
    summary: revision.summary,
    revision,
  };
}

function part(state: string, revision: PendingRevision = DRAFT, toolCallId = "call_1") {
  return {
    type: "tool-apply_document_revision",
    state,
    toolCallId,
    output: state === "output-available" ? appliedOutput(revision) : undefined,
  };
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: "20c4c1a0-1111-4111-8111-111111111111",
    content: "",
    updatedAt: "2026-10-17T10:00:00.000Z",
  });
});

describe("useAppliedRevisions", () => {
  it("leaves the document alone while the revision is still streaming", () => {
    renderHook(() => useAppliedRevisions([part("input-streaming")]));
    renderHook(() => useAppliedRevisions([part("input-available")]));

    expect(useDocumentStore.getState().content).toBe("");
  });

  it("applies the revision when its part reaches output-available", () => {
    renderHook(() => useAppliedRevisions([part("output-available")]));

    expect(useDocumentStore.getState().content).toBe(DRAFT.replacementText);
  });

  it("applies a part that arrives already finished on its first render", () => {
    // the chat panel can mount after the stream settled; the change must not be lost
    renderHook(() => useAppliedRevisions([part("output-available")]));

    expect(useDocumentStore.getState().content).toBe(DRAFT.replacementText);
  });

  it("applies each tool call once, however often the parts re-render", () => {
    // A second application would re-run the whole-document draft against a
    // non-empty document; the store would refuse it, but a targeted revision
    // applied twice would corrupt the text, so this is a real guard.
    const targeted: PendingRevision = {
      targetRegion: { type: "anchor", anchorText: "The networks fell." },
      expectedText: "The networks fell.",
      replacementText: "The networks collapsed.",
      kind: "targeted",
      summary: "Changed the verb.",
    };

    useDocumentStore.setState({
      content: targeted.expectedText,
      persistedContent: targeted.expectedText,
    });

    const { rerender } = renderHook(({ parts }) => useAppliedRevisions(parts), {
      initialProps: { parts: [part("output-available", targeted)] },
    });

    rerender({ parts: [part("output-available", targeted)] });
    rerender({ parts: [part("output-available", targeted)] });

    expect(useDocumentStore.getState().content).toBe(targeted.replacementText);
  });

  it("applies nothing for a refused revision", () => {
    const refused = {
      type: "tool-apply_document_revision",
      state: "output-available",
      toolCallId: "call_2",
      output: {
        applied: false,
        reason: "stale_region",
        message: "The document changed.",
      },
    };

    renderHook(() => useAppliedRevisions([refused]));

    expect(useDocumentStore.getState().content).toBe("");
  });

  it("refuses a revision whose target the browser edited meanwhile (FR-015b)", () => {
    // The server validated against the stored document; in the browser the
    // anchor no longer holds. The store re-checks, and the user's text wins.
    useDocumentStore.setState({ content: "# Something I typed." });

    renderHook(() => useAppliedRevisions([part("output-available")]));

    expect(useDocumentStore.getState().content).toBe("# Something I typed.");
  });

  it("applies two different tool calls in the order they arrived", () => {
    const second: PendingRevision = {
      targetRegion: { type: "anchor", anchorText: "The networks fell." },
      expectedText: "The networks fell.",
      replacementText: "The networks collapsed.",
      kind: "targeted",
      summary: "Changed the verb.",
    };
    const first = {
      ...DRAFT,
      replacementText: "The networks fell.",
      summary: "Drafted.",
    };

    // Two renders that each expose one part, as streaming parts appear.
    const { rerender } = renderHook(({ parts }) => useAppliedRevisions(parts), {
      initialProps: { parts: [part("output-available", first, "call_a")] },
    });
    rerender({
      parts: [
        part("output-available", first, "call_a"),
        part("output-available", second, "call_b"),
      ],
    });

    expect(useDocumentStore.getState().content).toBe(second.replacementText);
  });

  it("does not write the same revision twice when the call is restored with the user's reply", () => {
    // The turn that asked a question ends and is stored; the user's answer
    // arrives as a new turn, so the call reaches the panel a second time, now
    // settled. It is the same change: writing it again would replace the text
    // that answered the first application.
    const TARGET = "Around 1200 BCE, the trade networks fell.";
    const CONTENT = `# The Bronze Age\n\n${TARGET}`;
    const REVISION: PendingRevision = {
      targetRegion: { type: "anchor", anchorText: TARGET },
      expectedText: TARGET,
      replacementText: "Around 1177 BCE, the trade networks collapsed.",
      kind: "targeted",
      summary: "Corrected the date.",
    };

    useDocumentStore.getState().loadScript({
      scriptId: SCRIPT_ID,
      conversationId: "20c4c1a0-1111-4111-8111-111111111111",
      content: CONTENT,
      updatedAt: "2026-10-17T10:00:00.000Z",
    });

    const restored = part("output-available", REVISION, "call_reply");
    const { rerender } = renderHook(
      ({ parts }: { parts: ReturnType<typeof part>[] }) => useAppliedRevisions(parts),
      { initialProps: { parts: [restored] } },
    );

    // The same settled call, re-rendered as a fresh copy, as a rebuilt
    // message list delivers it.
    const rebuilt = { ...restored, output: appliedOutput(REVISION) };

    rerender({ parts: [{ ...restored }] });
    rerender({ parts: [rebuilt] });

    expect(useDocumentStore.getState().content).toBe(
      `# The Bronze Age\n\n${REVISION.replacementText}`,
    );
  });

  describe("a full rewrite the user was asked about (FR-015c)", () => {
    const CONTENT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";
    const REWRITE: PendingRevision = {
      targetRegion: { type: "whole-document" },
      expectedText: CONTENT,
      replacementText: "# A different script\n\nWritten from the top.",
      kind: "wholesale-rewrite",
      summary: "Rewrote the whole script.",
    };

    beforeEach(() => {
      useDocumentStore.getState().loadScript({
        scriptId: SCRIPT_ID,
        conversationId: "20c4c1a0-1111-4111-8111-111111111111",
        content: CONTENT,
        updatedAt: "2026-10-17T10:00:00.000Z",
      });
    });

    const rewriteInput = {
      targetRegion: { wholeDocument: true },
      expectedText: CONTENT,
      replacementText: REWRITE.replacementText,
      isWholesaleDraft: false,
      summary: REWRITE.summary,
    };

    function asked(): ReturnType<typeof part> & Record<string, unknown> {
      return {
        ...part("approval-requested", REWRITE, "call_rewrite"),
        input: rewriteInput,
        approval: { id: "approval_rewrite", reason: "rewrite" },
      };
    }

    it("puts the rewrite to the user rather than applying it", () => {
      renderHook(() => useAppliedRevisions([asked()]));

      const state = useDocumentStore.getState();

      expect(state.content).toBe(CONTENT);
      expect(state.pendingRewrite).toMatchObject({ approvalId: "approval_rewrite" });
      // It is a rewrite question, not a clear question (FR-021).
      expect(state.pendingClear).toBeNull();
    });

    it("applies it with the user's consent once they confirm", () => {
      renderHook(() => useAppliedRevisions([asked()]));

      act(() => {
        useDocumentStore.getState().confirmRewrite();
      });

      expect(useDocumentStore.getState().content).toBe(REWRITE.replacementText);
    });

    it("writes nothing for a declined rewrite, even when its result arrives", () => {
      const declined = {
        ...part("output-available", REWRITE, "call_rewrite"),
        approval: { id: "approval_rewrite", reason: "rewrite", approved: false },
      };

      renderHook(() => useAppliedRevisions([asked(), declined]));

      expect(useDocumentStore.getState().content).toBe(CONTENT);
      expect(useDocumentStore.getState().pendingRewrite).not.toBeNull();
    });
  });
});
