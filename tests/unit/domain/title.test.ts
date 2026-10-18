import { describe, expect, it } from "vitest";

import { checkTitle, normalizeTitle, TITLE_MAX_LENGTH } from "@/lib/domain/title";

describe("checkTitle", () => {
  describe("blank", () => {
    it("rejects an empty title", () => {
      expect(checkTitle("")).toEqual({ valid: false, rule: "blank" });
    });

    it("rejects a whitespace-only title", () => {
      expect(checkTitle("   \t\n ")).toEqual({ valid: false, rule: "blank" });
    });

    it("accepts a title with internal whitespace", () => {
      expect(checkTitle("The  Fall\tof Rome")).toMatchObject({ valid: true });
    });
  });

  describe("length", () => {
    it("accepts a title of exactly the maximum length", () => {
      expect(checkTitle("a".repeat(TITLE_MAX_LENGTH))).toMatchObject({ valid: true });
    });

    it("rejects a title of exactly one character over the maximum", () => {
      expect(checkTitle("a".repeat(TITLE_MAX_LENGTH + 1))).toEqual({
        valid: false,
        rule: "too_long",
      });
    });

    it("rejects a 201-character title, the boundary a user reports", () => {
      expect(checkTitle("x".repeat(201))).toEqual({ valid: false, rule: "too_long" });
    });

    it("measures length after trimming, so padding does not count", () => {
      const padded = `  ${"a".repeat(TITLE_MAX_LENGTH)}  `;

      expect(checkTitle(padded)).toMatchObject({ valid: true, title: "a".repeat(200) });
    });

    it("counts a multi-byte character as one, matching what the user typed", () => {
      // 200 emoji are 200 characters to a user, however many UTF-16 code units
      // or bytes they occupy.
      expect(checkTitle("🎬".repeat(TITLE_MAX_LENGTH))).toMatchObject({ valid: true });
      expect(checkTitle("🎬".repeat(TITLE_MAX_LENGTH + 1))).toEqual({
        valid: false,
        rule: "too_long",
      });
    });

    it("names each rule distinctly, so the user is told which one broke", () => {
      const blank = checkTitle("");
      const tooLong = checkTitle("a".repeat(TITLE_MAX_LENGTH + 1));

      expect(blank.valid).toBe(false);
      expect(tooLong.valid).toBe(false);
      expect(blank).not.toEqual(tooLong);
    });
  });

  describe("normalization", () => {
    it("returns the trimmed title for storage", () => {
      expect(checkTitle("  My Film  ")).toMatchObject({ title: "My Film" });
    });

    it("keeps the title's own casing for display", () => {
      expect(checkTitle("My Film")).toMatchObject({ title: "My Film" });
    });
  });
});

describe("normalizeTitle", () => {
  it("collides titles that differ only in case", () => {
    expect(normalizeTitle("My Film")).toBe(normalizeTitle("MY FILM"));
  });

  it("collides titles that differ only in surrounding whitespace", () => {
    expect(normalizeTitle("My Film")).toBe(normalizeTitle("  My Film\t"));
  });

  it('treats "My Film" and "my film " as the same title', () => {
    expect(normalizeTitle("My Film")).toBe(normalizeTitle("my film "));
  });

  it("keeps internal whitespace significant, so two distinct titles stay distinct", () => {
    expect(normalizeTitle("My Film")).not.toBe(normalizeTitle("MyFilm"));
  });

  it("reports the same key from checkTitle as normalizeTitle does", () => {
    const check = checkTitle("  The Bronze AGE  ");

    expect(check.valid && check.normalized).toBe(normalizeTitle("  The Bronze AGE  "));
  });
});
