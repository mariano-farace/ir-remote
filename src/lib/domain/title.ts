/**
 * Title rules (FR-001a, FR-001b, FR-001c).
 *
 * A script's title is required, never defaulted, and must be non-blank, at most
 * 200 characters, and unique case-insensitively on its trimmed value. This
 * module owns that rule set once, so creation and rename cannot drift apart.
 *
 * The rules are pure and framework-free; the database enforces the same limits
 * (see `db/migrations/0001_initial.sql`) so a race cannot slip past validation.
 */

export const TITLE_MAX_LENGTH = 200;

/** Trims the title and folds case, which is what uniqueness is compared on. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** The two ways a title can be unacceptable on its own merits. */
export type TitleRule = "blank" | "too_long";

/** A title that satisfies the length and content rules. */
export interface ValidTitle {
  readonly valid: true;
  /** The trimmed title, which is what gets stored. */
  readonly title: string;
  /** The trimmed and lowercased title, the uniqueness key. */
  readonly normalized: string;
}

/** A title that does not. The rule names which one it broke. */
export interface InvalidTitle {
  readonly valid: false;
  readonly rule: TitleRule;
}

export type TitleCheck = ValidTitle | InvalidTitle;

/**
 * Checks a title against the content rules. Uniqueness is not a property of a
 * single title, so it is enforced by the repository against existing scripts.
 */
export function checkTitle(raw: string): TitleCheck {
  const title = raw.trim();

  if (title === "") {
    return { valid: false, rule: "blank" };
  }

  // Counted in code points so an emoji or an accented letter is one character,
  // matching what a user would say out loud and what they typed.
  if ([...title].length > TITLE_MAX_LENGTH) {
    return { valid: false, rule: "too_long" };
  }

  return { valid: true, title, normalized: normalizeTitle(title) };
}
