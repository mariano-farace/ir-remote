import { describe, expect, it } from "vitest";

import {
  buildChatRequest,
  buildSystemPrompt,
  REQUEST_DOCUMENT_DELIMITER,
} from "@/lib/ai/prompt";
import type { Style } from "@/lib/domain/types";

/**
 * The system prompt is where the style's guidance and the current document
 * meet the model (FR-010, FR-014, FR-018). Two properties matter:
 *
 *  - the guidance shapes the request quietly: it is part of the system prompt
 *    and never becomes a chat message (FR-011);
 *  - the prompt is built from the document *as it is now*, so a manual edit
 *    reaches the model on the very next request.
 */

const STYLE: Style = {
  id: "historical-documentary",
  name: "Historical Documentary",
  description: "Measured, archival narration.",
  guidance:
    "Write in a measured, archival register. Anchor every claim in concrete evidence and dates.",
};

const DOCUMENT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

describe("buildSystemPrompt", () => {
  it("includes the style's guidance, so every response is shaped by it (FR-010)", () => {
    const prompt = buildSystemPrompt({ style: STYLE, document: DOCUMENT });

    expect(prompt).toContain(STYLE.guidance);
  });

  it("includes the current document text, so the model edits what the user has (FR-014)", () => {
    const prompt = buildSystemPrompt({ style: STYLE, document: DOCUMENT });

    expect(prompt).toContain(DOCUMENT);
  });

  it("quotes the document inside a delimiter, so it is not read as instructions", () => {
    const prompt = buildSystemPrompt({ style: STYLE, document: DOCUMENT });
    const delimited = `${REQUEST_DOCUMENT_DELIMITER}\n${DOCUMENT}\n${REQUEST_DOCUMENT_DELIMITER}`;

    expect(prompt).toContain(delimited);
  });

  it("builds from the document it is given, never a cached one (FR-018)", () => {
    const edited = DOCUMENT.replace("fell", "collapsed");

    const before = buildSystemPrompt({ style: STYLE, document: DOCUMENT });
    const after = buildSystemPrompt({ style: STYLE, document: edited });

    expect(before).toContain("fell");
    expect(before).not.toContain("collapsed");
    expect(after).toContain("collapsed");
  });

  it("treats an empty document as empty, so the model knows a first draft is needed (FR-012)", () => {
    const prompt = buildSystemPrompt({ style: STYLE, document: "" });

    expect(prompt).toContain("empty");
    expect(prompt).not.toContain(
      REQUEST_DOCUMENT_DELIMITER + "\n\n" + REQUEST_DOCUMENT_DELIMITER,
    );
  });

  it("never places the guidance in the message array (FR-011)", () => {
    // The builder returns exactly one thing — the system prompt string — and
    // `buildChatRequest` puts nothing else from the style into the messages.
    const request = buildChatRequest({
      style: STYLE,
      document: DOCUMENT,
      history: [{ role: "user", content: "Write about the Bronze Age collapse." }],
    });

    const messageText = request.messages.map((message) => message.content).join("\n");

    expect(messageText).not.toContain(STYLE.guidance);
    expect(request.system).toContain(STYLE.guidance);
  });

  it("switching style mid-conversation changes later system prompts and no earlier turn (FR-009, FR-010)", () => {
    const mystery: Style = {
      id: "mystery",
      name: "Mystery",
      description: "Slow-burning unease, withheld information.",
      guidance: "Hold back the conclusion. Build unease through unanswered questions.",
    };
    const history = [
      { role: "user" as const, content: "Write about the lost colony." },
      {
        role: "assistant" as const,
        content: "Wrote a first draft about the lost colony.",
      },
    ];

    const before = buildChatRequest({ style: STYLE, document: DOCUMENT, history });
    const after = buildChatRequest({ style: mystery, document: DOCUMENT, history });

    // The next request is shaped by the new style...
    expect(after.system).toContain(mystery.guidance);
    expect(after.system).not.toContain(STYLE.guidance);
    // ...and the conversation behind it is byte-for-byte what it was: the
    // style change edits the system prompt, never the transcript (FR-011).
    expect(after.messages).toEqual(before.messages);
    expect(JSON.stringify(after.messages)).not.toContain(mystery.guidance);
    expect(JSON.stringify(after.messages)).not.toContain(STYLE.guidance);
  });

  it("requires the revision tool rather than plain chat text (FR-016)", () => {
    const prompt = buildSystemPrompt({ style: STYLE, document: DOCUMENT });

    expect(prompt).toContain("apply_document_revision");
    expect(prompt).toMatch(/region-addressed/i);
  });
});
