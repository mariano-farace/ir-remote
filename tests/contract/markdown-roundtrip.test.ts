// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  markdownToHtml,
  markdownToJson,
  editorJsonToMarkdown,
} from "@/lib/editor/markdown";

/**
 * The Markdown boundary the editor sits behind (T040, research decision 9).
 *
 * The supported subset is headings, bold, italic, lists, blockquotes, links,
 * and plain paragraphs. The document is persisted as Markdown, so it must
 * survive a full round trip through the editor's own model unchanged: a
 * document → editor → document cycle that reflows or reorders text would
 * rewrite the user's file every time they opened it.
 */

const SUPPORTED_DOCUMENTS = {
  "a heading and a paragraph": "# The Bronze Age\n\nThe networks fell around 1200 BCE.",
  "several heading levels": "# Part One\n\n## The Collapse\n\nThe sea peoples arrived.",
  bold: "The **evidence** is thin.",
  italic: "A *contested* claim.",
  "bold inside italic": "It was *wholly **unexpected*** to them.",
  "a bullet list": "- Clay tablets\n- Broken seals\n- Abandoned ports",
  "an ordered list": "1. A drought\n2. A migration\n3. A collapse",
  "a nested list": "- Evidence\n  - Tablets\n  - Seals\n- Silence",
  "a blockquote": "> The world ended twice in one century.",
  "a link": "Read [the tablet record](https://example.org/tablets).",
  "plain paragraphs": "The first paragraph.\n\nThe second paragraph.\n\nThe third.",
  "inline code": "The word `wanax` appears once.",
  "a horizontal rule": "Before.\n\n---\n\nAfter.",
  "a mixed document": [
    "# The Collapse",
    "",
    "Around 1200 BCE, **every** network failed.",
    "",
    "> No single cause is recorded.",
    "",
    "- Drought",
    "- *Migration*",
    "",
    "See [the record](https://example.org/record).",
  ].join("\n"),
} as const;

describe("Markdown round trip", () => {
  describe.each(Object.entries(SUPPORTED_DOCUMENTS))("%s", (_name, markdown) => {
    it("parses to an editor document", () => {
      expect(markdownToJson(markdown).type).toBe("doc");
    });

    it("survives document → editor document → Markdown unchanged", () => {
      const roundTripped = editorJsonToMarkdown(markdownToJson(markdown));

      expect(roundTripped).toBe(markdown);
    });
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = editorJsonToMarkdown(
      markdownToJson(SUPPORTED_DOCUMENTS["a mixed document"]),
    );
    const twice = editorJsonToMarkdown(markdownToJson(once));

    expect(twice).toBe(once);
  });
});

describe("markdownToHtml (browser only)", () => {
  it("renders the supported marks as HTML", () => {
    expect(markdownToHtml("**bold** *italic* [link](https://example.org)")).toBe(
      '<p><strong>bold</strong> <em>italic</em> <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.org">link</a></p>',
    );
    expect(markdownToHtml("- one\n- two")).toContain("<ul>");
    expect(markdownToHtml("> quoted")).toContain("<blockquote>");
    expect(markdownToHtml("## Two")).toContain("<h2>");
  });

  it("treats an empty document as empty, not as an empty paragraph", () => {
    expect(markdownToHtml("")).toBe("");
    expect(editorJsonToMarkdown(markdownToJson(""))).toBe("");
  });
});
