import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  discardRecoveryCopy,
  offerRecoveryCopy,
  readRecoveryCopy,
} from "@/lib/editor/recovery-copy";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";

import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * The recovery copy the browser keeps for a failed save (FR-005b), exercised
 * where it matters: beside the database the script actually lives in.
 *
 * The copy belongs to one script, and restoring it is an ordinary save: the
 * text goes back through the content endpoint, which records the version it
 * replaced first. What this test holds is that the text a failed save left is
 * still the text the user gets back — and that it is never offered to a
 * different script.
 */

const scripts = new PostgresScriptRepository();

/**
 * The recovery copy uses the browser's local storage. There is none in a node
 * test process, so the smallest storage that behaves like it is installed for
 * the length of this file — the module is being exercised as the server sees
 * it, including how it copes without a DOM.
 */
if (typeof globalThis.localStorage === "undefined") {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, String(value)),
      removeItem: (key: string) => items.delete(key),
      clear: () => items.clear(),
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("a copy left by a failed save", () => {
  it("comes back byte for byte, and restoring it is a normal revision-first save", async () => {
    const created = await scripts.create({ title: "Recovered", styleId: null });
    const saved = "What the server has.";
    const unsaved =
      "What the user typed while the save was failing.\n\nWith a second line.";

    await scripts.updateContent(
      created.script.id,
      saved,
      created.script.updatedAt,
      "user",
    );

    // The save fails: the server never sees `unsaved`.
    offerRecoveryCopy({
      scriptId: created.script.id,
      content: unsaved,
      savedContent: saved,
    });

    const copy = readRecoveryCopy({ scriptId: created.script.id });

    expect(copy?.content).toBe(unsaved);
    expect((await scripts.get(created.script.id)).content).toBe(saved);

    // The user restores it and the workspace saves it.
    const current = await scripts.get(created.script.id);
    await scripts.updateContent(
      created.script.id,
      copy?.content ?? "",
      current.updatedAt,
      "user",
    );

    expect((await scripts.get(created.script.id)).content).toBe(unsaved);
    // The text it replaced is a revision, so even this recovery is undoable.
    const revisions = await new (
      await import("@/lib/repositories/postgres/revision-repository")
    ).PostgresRevisionRepository().list(created.script.id);

    expect(revisions.map((revision) => revision.preview)).toContain(saved);
  });

  it("is never offered to another script", async () => {
    const first = await scripts.create({ title: "First", styleId: null });
    const second = await scripts.create({ title: "Second", styleId: null });

    offerRecoveryCopy({
      scriptId: first.script.id,
      content: "First script's unsaved text.",
      savedContent: "",
    });

    expect(readRecoveryCopy({ scriptId: second.script.id })).toBeNull();
    expect(readRecoveryCopy({ scriptId: first.script.id })?.content).toBe(
      "First script's unsaved text.",
    );
  });

  it("does not exist once the user has discarded it, on the next open", async () => {
    const created = await scripts.create({ title: "Declined", styleId: null });

    offerRecoveryCopy({
      scriptId: created.script.id,
      content: "Discarded.",
      savedContent: "",
    });
    discardRecoveryCopy({ scriptId: created.script.id });

    // Reopening the script finds nothing to offer.
    await scripts.get(created.script.id);

    expect(readRecoveryCopy({ scriptId: created.script.id })).toBeNull();
  });
});
