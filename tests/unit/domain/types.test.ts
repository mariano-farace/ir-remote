import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Message,
  MessageRole,
  PendingRevision,
  RevisionOrigin,
  Script,
  ScriptVersion,
  Style,
  StyleSummary,
} from "@/lib/domain/types";

/**
 * Two exports carry their invariants in the type itself:
 *
 *   `MessageRole` is the only speaker set a persisted message may have, and
 *   `RevisionOrigin` names the two write paths a version can record.
 *
 * A type-only guarantee cannot be tested by running code, so the assertions
 * below are `expectTypeOf`, which Vitest checks at compile time. Everything
 * else in `types.ts` is an interface with no invariant of its own: the title
 * rules live in `src/lib/domain/title.ts` (T028, T084) and style immutability
 * is enforced by the repository (T070), so they are not duplicated here.
 */
/** Widens a type alias so `expectTypeOf` can name it in a failure message. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertMessageRoleIsExhaustive(role: MessageRole): MessageRole {
  return role;
}

describe("domain types", () => {
  describe("MessageRole", () => {
    it("accepts exactly the two speakers a message may have", () => {
      expectTypeOf<MessageRole>().toEqualTypeOf<"user" | "assistant">();
    });

    it("rejects every other speaker, including the system role", () => {
      expectTypeOf<
        Equal<MessageRole, "user" | "assistant" | "system">
      >().toEqualTypeOf<false>();
      expectTypeOf<Equal<MessageRole, "user">>().toEqualTypeOf<false>();
      expectTypeOf<Equal<MessageRole, "assistant">>().toEqualTypeOf<false>();
    });

    it("round-trips a role through the narrowest type without widening", () => {
      const role: MessageRole = "assistant";

      expect(assertMessageRoleIsExhaustive(role)).toBe("assistant");
    });

    it("is the type a persisted Message carries", () => {
      expectTypeOf<Message["role"]>().toEqualTypeOf<MessageRole>();
    });
  });

  describe("RevisionOrigin", () => {
    it("names exactly the two write paths a version can record", () => {
      expectTypeOf<RevisionOrigin>().toEqualTypeOf<"user" | "assistant">();
    });

    it("matches the speaker set, because a version records who superseded it", () => {
      expectTypeOf<RevisionOrigin>().toEqualTypeOf<MessageRole>();
      expectTypeOf<ScriptVersion["origin"]>().toEqualTypeOf<RevisionOrigin>();
    });
  });

  describe("entity shape", () => {
    it("keeps a script's style optional until the user assigns one", () => {
      expectTypeOf<Script["styleId"]>().toEqualTypeOf<string | null>();
    });

    it("keeps the style guidance out of the catalogue the user sees", () => {
      expectTypeOf<StyleSummary>().not.toHaveProperty("guidance");
      expectTypeOf<Style["guidance"]>().toEqualTypeOf<string>();
    });

    it("gives a pending revision both the text it expects and its replacement", () => {
      expectTypeOf<PendingRevision["expectedText"]>().toEqualTypeOf<string>();
      expectTypeOf<PendingRevision["replacementText"]>().toEqualTypeOf<string>();
    });
  });
});
