/**
 * Render-boundary sanitization (Principle IV): model output is untrusted input
 * and never reaches the DOM as raw HTML.
 *
 * The HTML rendered by the editor is produced by the Markdown boundary
 * (`markdown.ts`), but its source text comes from the model. Anything a
 * script element, an event-handler attribute, or an unsafe URL could do is
 * stripped here, before TipTap sees it. DOMPurify is used rather than a
 * hand-rolled allowlist because bypasses of hand-rolled sanitizers are the
 * normal case, not the exception.
 *
 * The allowlist is deliberately the Markdown subset the editor supports
 * (StarterKit without code blocks, plus links and tables of lists/quotes):
 * a tag outside it is dropped rather than rendered.
 */

import DOMPurify, { type Config } from "dompurify";

const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "p",
  "br",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
];

const ALLOWED_ATTR = ["href", "title", "src", "alt", "target", "rel"];

const CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Only schemes that cannot execute. `javascript:`, `data:` (for every tag
  // except images, which DOMPurify handles separately), and `vbscript:` are
  // refused even when obfuscated with case, whitespace, or entities.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  FORBID_TAGS: ["style"],
  FORBID_ATTR: ["style"],
  // DOMPurify's default image data-URI handling stays on, which is what keeps
  // SVG payloads in `img src` from being treated as script.
  ADD_ATTR: ["target"],
};

/**
 * Strips anything executable from HTML before it is rendered.
 *
 * Idempotent: sanitizing already-sanitized output changes nothing.
 */
export function sanitizeHtml(html: string): string {
  if (html === "") {
    return "";
  }

  return DOMPurify.sanitize(html, CONFIG) as unknown as string;
}
