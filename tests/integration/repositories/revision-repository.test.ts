import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScriptId } from "@/lib/domain/types";
import { PostgresRevisionRepository } from "@/lib/repositories/postgres/revision-repository";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { RepositoryError } from "@/lib/repositories/types";

import {
  closeTestDatabase,
  getTestPool,
  pointPoolAtTestDatabase,
  resetDatabase,
} from "../support/fixtures";

/**
 * Revision persistence (FR-020, constitution Recoverability).
 *
 * The single invariant: a content change never lands without a version of the
 * content it replaced. Everything the undo affordance promises rests on it —
 * if a write could commit without its version, that write would be permanent
 * the moment autosave saved it.
 */

const revisions = new PostgresRevisionRepository();
const scripts = new PostgresScriptRepository();

let titleCounter = 0;

/** A script with its initial content and the `updatedAt` a first save must use as its base. */
async function createScript(content = ""): Promise<{ id: ScriptId; updatedAt: string }> {
  titleCounter += 1;
  const { script } = await scripts.create({
    title: `Revision Test ${titleCounter}`,
    styleId: null,
    content,
  });

  return { id: script.id, updatedAt: script.updatedAt };
}

async function versionRows(scriptId: ScriptId) {
  const result = await getTestPool().query<{ content: string; origin: string }>(
    "SELECT content, origin FROM script_versions WHERE script_id = $1 ORDER BY created_at, id",
    [scriptId],
  );

  return result.rows;
}

async function storedContent(scriptId: ScriptId): Promise<string | undefined> {
  const result = await getTestPool().query<{ content: string }>(
    "SELECT content FROM scripts WHERE id = $1",
    [scriptId],
  );

  return result.rows[0]?.content;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("PostgresRevisionRepository.updateContent", () => {
  it("writes the prior content as a version before applying the new content", async () => {
    const { id, updatedAt } = await createScript("Before.");

    await scripts.updateContent(id, "After.", updatedAt, "assistant");

    expect(await versionRows(id)).toEqual([{ content: "Before.", origin: "assistant" }]);
    expect(await storedContent(id)).toBe("After.");
  });

  it("records the empty starting document of a new script as its first version", async () => {
    const { id, updatedAt } = await createScript();

    await scripts.updateContent(id, "First words.", updatedAt, "user");

    expect(await versionRows(id)).toEqual([{ content: "", origin: "user" }]);
  });

  it("returns the new updatedAt, which the next write must use as its base", async () => {
    const { id, updatedAt } = await createScript();

    const first = await scripts.updateContent(id, "One.", updatedAt, "user");
    const second = await scripts.updateContent(id, "Two.", first.updatedAt, "user");

    expect(new Date(first.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(updatedAt).getTime(),
    );
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
      new Date(first.updatedAt).getTime(),
    );
    expect(await versionRows(id)).toEqual([
      { content: "", origin: "user" },
      { content: "One.", origin: "user" },
    ]);
  });

  it("refuses a write whose baseUpdatedAt is behind the stored value, writing nothing", async () => {
    const { id, updatedAt } = await createScript("Original.");
    await scripts.updateContent(id, "Newer.", updatedAt, "user");

    await expect(
      scripts.updateContent(id, "Stale overwrite.", updatedAt, "user"),
    ).rejects.toMatchObject({ code: "stale_write" });

    expect(await storedContent(id)).toBe("Newer.");
    expect(await versionRows(id)).toEqual([{ content: "Original.", origin: "user" }]);
  });

  it("reports a stale write as a RepositoryError", async () => {
    const { id, updatedAt } = await createScript();
    await scripts.updateContent(id, "Newer.", updatedAt, "user");

    await expect(
      scripts.updateContent(id, "Old.", updatedAt, "user"),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it("reports not_found for an unknown script", async () => {
    await expect(
      scripts.updateContent(
        "4d1c8e5a-0000-4000-8000-000000000000",
        "Text.",
        new Date().toISOString(),
        "user",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports not_found for a malformed id rather than leaking a driver error", async () => {
    await expect(
      scripts.updateContent("not-a-uuid", "Text.", new Date().toISOString(), "user"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("never mixes one script's versions into another's", async () => {
    const first = await createScript("First script.");
    const second = await createScript("Second script.");

    await scripts.updateContent(first.id, "First, edited.", first.updatedAt, "user");

    expect(await versionRows(second.id)).toEqual([]);
    expect(await versionRows(first.id)).toEqual([
      { content: "First script.", origin: "user" },
    ]);
  });
});

describe("PostgresRevisionRepository.list", () => {
  it("lists a script's versions newest first with a 1-based index", async () => {
    const { id, updatedAt } = await createScript("One.");
    const second = await scripts.updateContent(id, "Two.", updatedAt, "user");
    await scripts.updateContent(id, "Three.", second.updatedAt, "user");

    const listed = await revisions.list(id);

    expect(listed.map((version) => version.index)).toEqual([2, 1]);
    // The script starts holding "One."; the first write records it and stores
    // "Two.", and the second records "Two." and stores "Three.". Newest first,
    // that is the undo order.
    expect(listed.map((version) => version.preview)).toEqual(["Two.", "One."]);
    expect(listed.every((version) => version.origin === "user")).toBe(true);
  });

  it("orders versions by write even when several land in one transaction timestamp", async () => {
    const { id, updatedAt } = await createScript("One.");
    const second = await scripts.updateContent(id, "Two.", updatedAt, "user");
    await scripts.updateContent(id, "Three.", second.updatedAt, "user");

    // Two writes within one engine tick (and often one transaction timestamp).
    // PostgreSQL's now() is fixed per transaction, so ordering by created_at
    // alone would tie and fall back to a random UUID.
    const times = (await revisions.list(id)).map((version) => version.createdAt);

    expect(new Set(times).size).toBe(2);
    expect(Date.parse(times[0] ?? "")).toBeGreaterThan(Date.parse(times[1] ?? ""));
  });

  it("previews only the first 200 characters", async () => {
    const long = `${"a".repeat(200)}${"b".repeat(20)}`;
    const { id, updatedAt } = await createScript(long);

    await scripts.updateContent(id, "Short.", updatedAt, "user");

    const [version] = await revisions.list(id);

    expect(version?.preview).toBe("a".repeat(200));
  });

  it("returns an empty list for a script with no versions", async () => {
    const { id } = await createScript();

    expect(await revisions.list(id)).toEqual([]);
  });

  it("reports not_found for an unknown script", async () => {
    await expect(
      revisions.list("4d1c8e5a-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports not_found for a malformed script id rather than leaking a driver error", async () => {
    await expect(revisions.list("not-a-uuid")).rejects.toBeInstanceOf(RepositoryError);
    await expect(revisions.list("not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("PostgresRevisionRepository.restore", () => {
  it("restores a prior version's content", async () => {
    const { id, updatedAt } = await createScript("Original.");
    const second = await scripts.updateContent(id, "Edited.", updatedAt, "user");
    const [oldest] = (await revisions.list(id)).filter(
      (version) => version.preview === "Original.",
    );

    await revisions.restore(id, oldest?.id ?? "");

    expect(await storedContent(id)).toBe("Original.");
    expect(second.updatedAt).toEqual(expect.any(String));
  });

  it("records the content it replaced as a new version, so a restore is undoable", async () => {
    const { id, updatedAt } = await createScript("Original.");
    await scripts.updateContent(id, "Edited.", updatedAt, "user");
    const original = (await revisions.list(id)).find(
      (version) => version.preview === "Original.",
    );

    await revisions.restore(id, original?.id ?? "");

    expect(await versionRows(id)).toEqual([
      { content: "Original.", origin: "user" },
      { content: "Edited.", origin: "user" },
    ]);
  });

  it("reports not_found for a version that belongs to another script, leaving both untouched", async () => {
    const first = await createScript("First.");
    const second = await createScript("Second.");
    await scripts.updateContent(first.id, "First, edited.", first.updatedAt, "user");
    const [foreign] = await revisions.list(first.id);

    await expect(revisions.restore(second.id, foreign?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });

    expect(await storedContent(second.id)).toBe("Second.");
  });

  it("reports not_found for an unknown version", async () => {
    const { id } = await createScript();

    await expect(
      revisions.restore(id, "3c3c3c3c-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports not_found for a malformed version id", async () => {
    const { id } = await createScript();

    await expect(revisions.restore(id, "not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rolls back and passes a database failure through instead of calling it missing", async () => {
    const { id, updatedAt } = await createScript("Before.");
    await scripts.updateContent(id, "After.", updatedAt, "assistant");
    const [version] = await revisions.list(id);

    // The restore cannot reach the database at all; that is not "not found".
    await closeTestDatabase();

    try {
      const failure = await revisions
        .restore(id, version?.id ?? "")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RepositoryError);
    } finally {
      await pointPoolAtTestDatabase();
    }

    // Nothing was written by the failed restore: the content is as it was.
    await expect(storedContent(id)).resolves.toBe("After.");
    await expect(revisions.list(id)).resolves.toHaveLength(1);
  });
});

describe("PostgresRevisionRepository.get", () => {
  it("returns a version with its full content", async () => {
    const long = `${"a".repeat(200)}${"b".repeat(20)}`;
    const { id, updatedAt } = await createScript(long);
    await scripts.updateContent(id, "Short.", updatedAt, "assistant");
    const [version] = await revisions.list(id);

    const stored = await revisions.get(id, version?.id ?? "");

    expect(stored.content).toBe(long);
    expect(stored.scriptId).toBe(id);
    expect(stored.origin).toBe("assistant");
  });

  it("reports not_found for an unknown or malformed version id", async () => {
    const { id } = await createScript();

    await expect(
      revisions.get(id, "3c3c3c3c-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(revisions.get(id, "not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
