import { describe, expect, it } from "vitest";

import {
  composerControl,
  proposalApplication,
  requestAfterStop,
} from "@/lib/chat/chat-composer";

/**
 * Stopping a streamed answer (FR-014a, FR-014b).
 *
 * While a response streams, the panel offers to stop it and accepts no second
 * request for the script: the control is a stop button, and not a send button
 * that happens to be usable. Stopping ends the response at once; a revision
 * already applied stays applied, and nothing partly written is persisted —
 * which holds because only a settled tool result ever reaches the document.
 */

const IDLE = { streaming: false, hasText: true, ready: true } as const;

describe("composerControl", () => {
  it("is a stop control while a response streams", () => {
    expect(composerControl({ ...IDLE, streaming: true })).toEqual({ kind: "stop" });
  });

  it("is a send control when nothing is streaming", () => {
    expect(composerControl(IDLE)).toEqual({ kind: "send", disabled: false });
  });

  it("cannot send while a response streams, even with text in the prompt", () => {
    // The same rule the send handler enforces: a second concurrent request
    // for the same script is never made (FR-014a).
    const control = composerControl({ ...IDLE, streaming: true });

    expect(control.kind).not.toBe("send");
  });

  it("disables send for an empty prompt, a prompt of spaces, or an unready script", () => {
    expect(composerControl({ ...IDLE, hasText: false })).toEqual({
      kind: "send",
      disabled: true,
    });
    expect(composerControl({ ...IDLE, hasText: true, ready: false })).toEqual({
      kind: "send",
      disabled: true,
    });
  });
});

describe("proposalApplication", () => {
  it("applies a tool result only once it has settled", () => {
    const settled = {
      type: "tool-apply_document_revision",
      state: "output-available",
      output: { applied: true, summary: "Cut the intro." },
    };

    expect(proposalApplication(settled)).toBe("apply");
  });

  it("never applies a partially streamed tool call", () => {
    for (const state of ["input-streaming", "input-available"]) {
      expect(
        proposalApplication({
          type: "tool-apply_document_revision",
          state,
          input: { replacementText: "# A " },
          output: undefined,
        }),
      ).toBe("none");
    }
  });

  it("never applies a tool part that carries no settled state", () => {
    expect(
      proposalApplication({
        type: "tool-apply_document_revision",
        output: { applied: true, summary: "Applied before anything settled." },
      }),
    ).toBe("none");
  });

  it("never applies a call still waiting for the user, or one they declined", () => {
    for (const state of [
      "approval-requested",
      "approval-responded",
      "output-denied",
      "output-error",
    ]) {
      expect(proposalApplication({ type: "tool-apply_document_revision", state })).toBe(
        "none",
      );
    }
  });

  it("applies nothing for a settled result that was refused", () => {
    expect(
      proposalApplication({
        type: "tool-apply_document_revision",
        state: "output-available",
        output: { applied: false, message: "The script changed." },
      }),
    ).toBe("none");
  });
});

describe("requestAfterStop", () => {
  it("keeps a revision already applied and drops anything after the stop", () => {
    const applied = { id: "revision-1", state: "applied" } as const;
    const partial = { id: "revision-2", state: "streaming" } as const;

    expect(requestAfterStop({ applied: [applied], inFlight: partial })).toEqual([
      applied,
    ]);
  });

  it("persists no revision for a stop that arrived before any settled", () => {
    expect(
      requestAfterStop({
        applied: [],
        inFlight: { id: "revision-1", state: "streaming" },
      }),
    ).toEqual([]);
  });

  it("lets the prompt be edited again once the answer is stopped", () => {
    // A stopped turn accepts the next request.
    expect(composerControl({ ...IDLE, streaming: false })).toEqual({
      kind: "send",
      disabled: false,
    });
  });
});
