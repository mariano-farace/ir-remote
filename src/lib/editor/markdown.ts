/**
 * The Markdown boundary (TR04). Markdown is the persisted format; TipTap's
 * document model is what the editor renders.
 *
 * Everything outside this module speaks Markdown. If the Markdown engine ever
 * changes, only this file does; no component imports the editor's serializer,
 * and no domain code imports the editor at all.
 *
 * HTML produced here is fed to TipTap's schema, which drops any node or mark it
 * does not know. Safety (sanitization) is a separate render-boundary module
 * (`sanitize.ts`) applied in `markdownToHtml`; this module is not the place
 * that decides what is dangerous.
 */

import { getSchema } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { sanitizeHtml } from "@/lib/editor/sanitize";

/**
 * The supported subset: StarterKit without code blocks, plus links (which are
 * in scope) and the Markdown serializer. StarterKit already includes `link`, so
 * it is configured there rather than registered a second time — a duplicate
 * extension name makes TipTap drop one of them arbitrarily.
 */
export function editorExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: false },
    }),
    Markdown,
  ];
}

let cachedManager: MarkdownManager | undefined;

function manager(): MarkdownManager {
  cachedManager ??= new MarkdownManager({ extensions: editorExtensions() });

  return cachedManager;
}

/** The editor's document as JSON — the shape TipTap reads and writes. */
export function markdownToJson(markdown: string): JSONContent {
  return manager().parse(markdown);
}

/** The editor's document back to the Markdown that is persisted. */
export function editorJsonToMarkdown(document: JSONContent): string {
  return manager().serialize(document);
}

/**
 * Markdown to HTML, for the editor's initial content.
 *
 * Empty in, empty out: a blank script has no paragraphs to render, and the
 * editor's own empty state must stay distinguishable from a document that
 * genuinely holds one blank line.
 *
 * Raw HTML embedded in the Markdown is carried through the serializer as HTML,
 * so the result is sanitized before it leaves this function (Principle IV).
 */
export function markdownToHtml(markdown: string): string {
  const json = markdownToJson(markdown);

  if (!json.content || json.content.length === 0) {
    return "";
  }

  const schema = getSchema(editorExtensions());
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
    schema.nodeFromJSON(json).content,
  );
  const container = document.createElement("div");

  container.appendChild(fragment);

  return sanitizeHtml(container.innerHTML);
}
