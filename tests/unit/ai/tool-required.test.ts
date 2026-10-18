import { describe, expect, it } from "vitest";

import { buildChatRequest, buildSystemPrompt } from "@/lib/ai/prompt";
import type { DocumentRevisionInput } from "@/lib/ai/tools";
import { toPendingRevision, validateDocumentRevision } from "@/lib/ai/tools";
import type { Style } from "@/lib/domain/types";

/**
 * A first draft is asked for, and only then written (FR-012).
 *
 * The model writes the script only by calling the one tool. When there is no
 * topic there is nothing to draft, and the workspace must not conjure a script
 * from nothing; when there is a topic and the script is empty, the answer is
 * exactly one wholesale draft, which the document rules accept.
 */

const STYLE: Style = {
  id: "historical-documentary",
  name: "Historical Documentary",
  description: "Measured, evidence-led.",
  guidance: "Write in a measured, evidence-led register.",
};

const TOPIC = "The collapse of the Bronze Age trade networks";

const FIRST_DRAFT_INPUT: DocumentRevisionInput = {
  targetRegion: { wholeDocument: true },
  expectedText: "",
  replacementText: "# The Bronze Age\n\nAround 1200 BCE, the networks fell.",
  isWholesaleDraft: true,
  summary: "Wrote a first draft about the Bronze Age collapse.",
};

describe("a request with no topic", () => {
  it("is never a draft request: an empty history is the only thing sent", () => {
    // With no turns there is no topic, and the request carries no script text
    // for the model to write into a draft either.
    const request = buildChatRequest({ style: STYLE, document: "", history: [] });

    expect(request.messages).toEqual([]);
  });

  it("cannot produce a draft through the tool: no call, no change", () => {
    // The tool writes only what it is called with. With no call there is no
    // result, and the empty document stays empty.
    expect(validateDocumentRevision(undefined, "")).toMatchObject({
      applied: false,
      reason: "validation_error",
    });
  });
});

describe("a topic request on an empty document", () => {
  it("is told, in the prompt, that the script is empty and how to draft it", () => {
    const system = buildSystemPrompt({ style: STYLE, document: "" });

    expect(system).toMatch(/script is currently empty/i);
    expect(system).toMatch(/isWholesaleDraft/);
    expect(system).toMatch(/`expectedText` empty/);
  });

  it("produces exactly one wholesale proposal", () => {
    const outcome = validateDocumentRevision(FIRST_DRAFT_INPUT, "");

    expect(outcome.applied).toBe(true);
    expect(outcome).toMatchObject({ content: FIRST_DRAFT_INPUT.replacementText });

    // One proposal, of the first-draft kind: a wholesale write into an empty
    // document, which is the permitted first case of FR-015c.
    const revision = toPendingRevision(FIRST_DRAFT_INPUT);

    expect(revision.kind).toBe("first-draft");
    expect(revision.targetRegion).toEqual({ type: "whole-document" });
  });

  it("is sent with the topic as its only user turn", () => {
    const request = buildChatRequest({
      style: STYLE,
      document: "",
      history: [{ role: "user", content: TOPIC }],
    });

    expect(request.messages).toEqual([{ role: "user", content: TOPIC }]);
  });
});
