import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "@/lib/editor/sanitize";

/**
 * Principle IV: model output never reaches the DOM as raw HTML. Whatever the
 * Markdown boundary produces is stripped of anything able to execute before it
 * is handed to the editor.
 */
describe("sanitizeHtml", () => {
  it("removes a script element and its contents", () => {
    const result = sanitizeHtml(
      "<p>Before</p><script>window.stolen = document.cookie;</script><p>After</p>",
    );

    expect(result).not.toContain("<script");
    expect(result).not.toContain("document.cookie");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it.each([
    ["onclick", '<p onclick="steal()">Click me</p>'],
    ["onerror", '<img src="x" onerror="steal()">'],
    ["onmouseover", '<a href="#" onmouseover="steal()">Hover</a>'],
    ["onload", '<svg onload="steal()"></svg>'],
  ])("removes the %s event-handler attribute", (_name, html) => {
    const result = sanitizeHtml(html);

    expect(result).not.toMatch(/\son[a-z]+\s*=/i);
    expect(result).not.toContain("steal()");
  });

  it.each([
    "<a href=\"javascript:alert('x')\">Link</a>",
    "<a href=\"JaVaScRiPt:alert('x')\">Link</a>",
    "<a href=\" javascript:alert('x')\">Link</a>",
    "<a href=\"java&#115;cript:alert('x')\">Link</a>",
    "<img src=\"javascript:alert('x')\">",
  ])("removes the javascript: URL in %s", (html) => {
    const result = sanitizeHtml(html);

    expect(result.toLowerCase()).not.toContain("javascript:");
    expect(result).not.toContain("alert(");
  });

  it("keeps the Markdown subset the editor renders", () => {
    const html =
      "<h1>Title</h1><p><strong>Bold</strong> and <em>italic</em> and " +
      "<code>code</code></p><ul><li><p>Item</p></li></ul>" +
      "<blockquote><p>Quote</p></blockquote>" +
      '<p><a href="https://example.com/draft">Link</a></p>';

    const result = sanitizeHtml(html);

    expect(result).toContain("<h1>Title</h1>");
    expect(result).toContain("<strong>Bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain("<code>code</code>");
    expect(result).toContain("<li>");
    expect(result).toContain("<blockquote>");
    expect(result).toContain('href="https://example.com/draft"');
  });

  it("is safe to apply twice", () => {
    const once = sanitizeHtml("<p>Text</p><script>alert(1)</script>");

    expect(sanitizeHtml(once)).toBe(once);
  });

  it("returns empty output for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});
