import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RepositoryError } from "@/lib/repositories/types";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";

import {
  closeTestDatabase,
  firstStyleId,
  getTestPool,
  resetDatabase,
} from "../support/fixtures";

const repository = new PostgresScriptRepository();

async function countRows(table: string): Promise<number> {
  const result = await getTestPool().query<{ count: string }>(
    `SELECT count(*) FROM ${table}`,
  );

  return Number(result.rows[0]?.count ?? "-1");
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("PostgresScriptRepository.list", () => {
  it("returns an empty list when no scripts exist", async () => {
    expect(await repository.list()).toEqual([]);
  });

  it("orders scripts by last modification, most recent first (FR-002)", async () => {
    const pool = getTestPool();
    await pool.query(`
      INSERT INTO scripts (title, updated_at) VALUES
        ('Oldest', now() - interval '2 days'),
        ('Newest', now()),
        ('Middle', now() - interval '1 day')
    `);

    const titles = (await repository.list()).map((script) => script.title);

    expect(titles).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("omits the document text, so the sidebar list stays small", async () => {
    await getTestPool().query(
      "INSERT INTO scripts (title, content) VALUES ('A Film', '# Draft')",
    );

    const [summary] = await repository.list();

    expect(summary).not.toHaveProperty("content");
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      "id",
      "styleId",
      "title",
      "updatedAt",
    ]);
  });

  it("returns the stored style reference and an ISO timestamp", async () => {
    const pool = getTestPool();
    const styleId = await firstStyleId();
    await pool.query("INSERT INTO scripts (title, style_id) VALUES ('A Film', $1)", [
      styleId,
    ]);

    const [summary] = await repository.list();

    expect(summary?.styleId).toBe(styleId);
    expect(summary?.updatedAt).toMatch(/Z$/);
  });
});

describe("PostgresScriptRepository.get", () => {
  it("returns the script with its content", async () => {
    const pool = getTestPool();
    const styleId = await firstStyleId();
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO scripts (title, content, style_id) VALUES ('A Film', '# Draft', $1) RETURNING id",
      [styleId],
    );

    const script = await repository.get(inserted.rows[0]!.id);

    expect(script).toMatchObject({
      title: "A Film",
      content: "# Draft",
      styleId,
    });
    expect(script.createdAt).toBe(script.updatedAt);
  });

  it("reports not_found for an unknown id", async () => {
    await expect(
      repository.get("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reports not_found for an id that is not a UUID rather than leaking a driver error", async () => {
    // The route layer will pass whatever is in the URL. An invalid UUID is a
    // malformed request that must still map onto `not_found`, not onto a 500.
    await expect(repository.get("not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("error translation", () => {
  it("maps a connection failure onto the driver error, not a repository claim", async () => {
    // A non-sentinel failure must not be relabelled as a title or style problem:
    // telling the user their title was taken when the database is down is a lie
    // they will act on.
    await getTestPool().query("ALTER TABLE scripts RENAME TO scripts_offline");

    try {
      const attempt = repository.create({ title: "Any Title", styleId: null });

      await expect(attempt).rejects.toThrow(/does not exist/);
      await expect(attempt).rejects.not.toBeInstanceOf(RepositoryError);
    } finally {
      await getTestPool().query("ALTER TABLE scripts_offline RENAME TO scripts");
    }
  });
});

describe("PostgresScriptRepository.create", () => {
  it("yields exactly one conversation, owned by the new script", async () => {
    const created = await repository.create({
      title: "The Bronze Age Collapse",
      styleId: null,
    });

    expect(await countRows("conversations")).toBe(1);
    expect(created.conversation.scriptId).toBe(created.script.id);
    expect(created.conversation.id).toBeTruthy();
  });

  it("creates the script with empty content and the title it was given", async () => {
    const created = await repository.create({
      title: "  The Bronze Age Collapse  ",
      styleId: null,
    });

    expect(created.script.content).toBe("");
    expect(created.script.title).toBe("The Bronze Age Collapse");
    expect(created.script.styleId).toBeNull();
    expect(created.script.createdAt).toBe(created.script.updatedAt);
  });

  it("records a style reference when one is supplied", async () => {
    const styleId = await firstStyleId();
    const created = await repository.create({ title: "A Film", styleId });

    expect(created.script.styleId).toBe(styleId);
  });

  it("rejects a duplicate normalized title and leaves no partial script behind", async () => {
    const pool = getTestPool();
    await pool.query("INSERT INTO scripts (title) VALUES ('My Film')");

    const attempt = repository.create({ title: "  my FILM  ", styleId: null });

    await expect(attempt).rejects.toBeInstanceOf(RepositoryError);
    await expect(
      repository.create({ title: "my film ", styleId: null }),
    ).rejects.toMatchObject({
      code: "title_taken",
    });
    // The failed create must not have left a script or an orphan conversation.
    expect(await countRows("scripts")).toBe(1);
    expect(await countRows("conversations")).toBe(0);
  });

  it("rejects a blank title with a distinguishable reason", async () => {
    await expect(
      repository.create({ title: "   ", styleId: null }),
    ).rejects.toMatchObject({
      code: "title_required",
    });
    expect(await countRows("scripts")).toBe(0);
    expect(await countRows("conversations")).toBe(0);
  });

  it("rejects a title longer than 200 characters", async () => {
    await expect(
      repository.create({ title: "a".repeat(201), styleId: null }),
    ).rejects.toMatchObject({ code: "title_required" });
    expect(await countRows("scripts")).toBe(0);
  });

  it("rejects an unknown style without creating the script", async () => {
    await expect(
      repository.create({ title: "A Film", styleId: "no-such-style" }),
    ).rejects.toMatchObject({ code: "unknown_style" });
    expect(await countRows("scripts")).toBe(0);
    expect(await countRows("conversations")).toBe(0);
  });

  it("never leaves a script observable without its conversation", async () => {
    // A constraint that makes conversation creation fail after the script insert
    // would otherwise leave a script with no conversation (FR-001). The unique
    // style reference is the cheapest way to provoke a failure inside the
    // transaction after the script row is written.
    const pool = getTestPool();
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_conversation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'conversation insert refused'; END; $$;
      CREATE TRIGGER reject_conversation_trigger BEFORE INSERT ON conversations
        FOR EACH ROW EXECUTE FUNCTION reject_conversation();
    `);

    try {
      await expect(
        repository.create({ title: "Half Made", styleId: null }),
      ).rejects.toThrow();
      expect(await countRows("scripts")).toBe(0);
      expect(await countRows("conversations")).toBe(0);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_conversation_trigger ON conversations;
        DROP FUNCTION IF EXISTS reject_conversation();
      `);
    }
  });
});
