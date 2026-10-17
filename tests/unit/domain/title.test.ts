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

    it("rejects a title of one character over the maximum", () => {
      expect(checkTitle("a".repeat(TITLE_MAX_LENGTH + 1))).toEqual({
        valid: false,
        rule: "too_long",
      });
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

    it("folds case and surrounding whitespace into the uniqueness key", () => {
      expect(normalizeTitle("My Film")).toBe(normalizeTitle("  my film "));
    });

    it("collides 'My Film' with 'my film '", () => {
      const first = checkTitle("My Film");
      const second = checkTitle("  my film  ");

      expect(first.valid && second.valid).toBe(true);
      if (first.valid && second.valid) {
        expect(second.normalized).toBe(first.normalized);
      }
    });

    it("does not collide titles that differ internally", () => {
      const first = checkTitle("My Film");
      const second = checkTitle("MyFilm");

      if (first.valid && second.valid) {
        expect(second.normalized).not.toBe(first.normalized);
      }
    });

    it("folds non-ASCII case, so 'ÉTÉ' and 'été' collide", () => {
      expect(normalizeTitle("ÉTÉ")).toBe(normalizeTitle(" été "));
    });
  });
});
