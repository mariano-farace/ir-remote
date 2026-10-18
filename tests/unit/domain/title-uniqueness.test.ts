import { describe, expect, it } from "vitest";

import { checkTitle, normalizeTitle, TITLE_MAX_LENGTH } from "@/lib/domain/title";

/**
 * FR-001b: a title must be non-blank after trimming, at most 200 characters,
 * and unique among existing scripts when compared case-insensitively on the
 * trimmed value. A rejection must say which of those rules broke, so the user
 * is not left guessing between "you already have a script called this" and
 * "that title is too long".
 *
 * Uniqueness is compared on the normalized title, so this file fixes exactly
 * what "the same title" means; the database applies the same key, and the API
 * reports a duplicate as `title_taken` (tests/integration/api/scripts-create).
 */

type Rule = "blank" | "too_long" | "duplicate";

/** The reason a title was rejected, as the domain reports it. */
function rejectionOf(raw: string): Rule | null {
  const check = checkTitle(raw);

  return check.valid ? null : check.rule;
}

describe("what counts as the same title", () => {
  it("ignores case entirely", () => {
    const variants = [
      "The Salt Roads",
      "the salt roads",
      "THE SALT ROADS",
      "tHe SaLt RoAdS",
    ];

    const keys = new Set(variants.map(normalizeTitle));

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("the salt roads");
  });

  it("ignores leading and trailing whitespace, including tabs and newlines", () => {
    const variants = [
      "The Salt Roads",
      "  The Salt Roads",
      "The Salt Roads  ",
      "\tThe Salt Roads\n",
      "  \n The Salt Roads \t ",
    ];

    expect(new Set(variants.map(normalizeTitle)).size).toBe(1);
  });

  it("ignores case and surrounding whitespace together", () => {
    expect(normalizeTitle("   THE SALT ROADS\t")).toBe(normalizeTitle("the salt roads"));
    // The normalized title comes from the trimmed one: the rule composes.
    expect(checkTitle("  THE Salt Roads  ")).toMatchObject({
      valid: true,
      title: "THE Salt Roads",
      normalized: "the salt roads",
    });
  });

  it("does not fold internal whitespace, only the ends", () => {
    // The spec names trimming, not collapsing. "The  Salt Roads" (two spaces)
    // is a different title from "The Salt Roads", and neither is "TheSaltRoads".
    expect(normalizeTitle("The  Salt Roads")).not.toBe(normalizeTitle("The Salt Roads"));
    expect(normalizeTitle("The Salt Roads")).not.toBe(normalizeTitle("TheSaltRoads"));
  });

  it("treats titles differing only by a non-ASCII case as the same", () => {
    expect(normalizeTitle("Café Noir")).toBe(normalizeTitle("CAFÉ NOIR"));
    expect(normalizeTitle("Über Die Brücke")).toBe(normalizeTitle("über die brücke"));
  });

  it("distinguishes titles that differ by more than case or surrounding space", () => {
    expect(normalizeTitle("The Salt Roads")).not.toBe(normalizeTitle("The Salt Road"));
    expect(normalizeTitle("Kodak")).not.toBe(normalizeTitle("Kodaks"));
  });

  it("normalizes a blank title to the empty string, which is never accepted", () => {
    expect(normalizeTitle("   \t\n")).toBe("");
    expect(checkTitle("   \t\n")).toEqual({ valid: false, rule: "blank" });
  });
});

describe("each rejection reason is distinguishable", () => {
  it.each([
    ["", "blank"],
    ["   ", "blank"],
    ["\n\t ", "blank"],
    ["a".repeat(TITLE_MAX_LENGTH + 1), "too_long"],
    ["  " + "a".repeat(TITLE_MAX_LENGTH + 1) + "  ", "too_long"],
  ] satisfies Array<[string, Rule]>)("rejects %j as %s", (raw, rule) => {
    expect(rejectionOf(raw)).toBe(rule);
  });

  it("names blank and too-long as different rules, so the messages can differ", () => {
    const blank = checkTitle("");
    const tooLong = checkTitle("x".repeat(TITLE_MAX_LENGTH + 1));

    expect(blank).toEqual({ valid: false, rule: "blank" });
    expect(tooLong).toEqual({ valid: false, rule: "too_long" });
  });

  it("accepts a title that is merely padded to the limit", () => {
    // Padding is trimmed before the length is measured, so it is not the user's
    // title being too long.
    expect(checkTitle(`   ${"a".repeat(TITLE_MAX_LENGTH)}   `)).toMatchObject({
      valid: true,
    });
  });
});

/**
 * The uniqueness key is the normalized title; this helper is what callers use
 * to compare a candidate against existing scripts (the repository does so in
 * SQL against the same expression).
 */
function isDuplicate(candidate: string, existing: readonly string[]): boolean {
  const key = normalizeTitle(candidate);

  return existing.some((title) => normalizeTitle(title) === key);
}

describe("duplicate detection on the normalized title", () => {
  const existing = ["The Salt Roads", "Kodak Years", "Golden Gate"];

  it.each([
    "The Salt Roads",
    "the salt roads",
    "  THE SALT ROADS  ",
    "\tThe Salt Roads\n",
  ])("treats %j as a duplicate", (candidate) => {
    expect(isDuplicate(candidate, existing)).toBe(true);
  });

  it.each(["The Salt Road", "Salt Roads", "The Salt Roads II"])(
    "treats %j as distinct",
    (candidate) => {
      expect(isDuplicate(candidate, existing)).toBe(false);
    },
  );
});
