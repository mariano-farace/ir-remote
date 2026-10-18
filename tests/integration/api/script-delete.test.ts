import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DELETE as deleteScript } from "@/app/api/scripts/[id]/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Deleting a script (FR-001d): `DELETE /api/scripts/{id}`.
 *
 * Two guarantees are asserted, because both fail silently if they are lost:
 *
 *  - confirmation. A request without `confirm: true` removes nothing and says
 *    so with `400 confirmation_required`, so a stray DELETE cannot destroy work.
 *  - atomicity of the cascade. The script, its conversation, its messages, and
 *    its version history go together; a partially deleted script is never
 *    observable afterwards.
 *
 * A sibling script is always present so the assertions distinguish "deleted
 * this script's rows" from "deleted rows" (FR-006).
 */

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

function params(id: string): Params {
  return { params: Promise.resolve({ id }) };
}

async function create(title: string): Promise<string> {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest("http://localhost:3000/api/scripts", "POST", { title }),
  );

  return field(field(response.json, "data"), "id") as string;
}

/** Gives a script a conversation, messages, and revisions, the way use does. */
async function seedUsage(scriptId: string, label: string): Promise<void> {
  const pool = getTestPool();
  const conversation = await pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE script_id = $1",
    [scriptId],
  );
  const conversationId = conversation.rows[0]?.id;

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)",
    [conversationId, `Topic for ${label}`, `Wrote ${label}`],
  );
  await pool.query(
    "INSERT INTO script_versions (script_id, content, origin) VALUES ($1, $2, 'user'), ($1, $3, 'assistant')",
    [scriptId, `First ${label}`, `Second ${label}`],
  );
  await pool.query("UPDATE scripts SET content = $2 WHERE id = $1", [
    scriptId,
    `Current ${label}`,
  ]);
}

async function rowsOwnedBy(scriptId: string) {
  const pool = getTestPool();
  const [scripts, conversations, messages, versions] = await Promise.all([
    pool.query("SELECT id FROM scripts WHERE id = $1", [scriptId]),
    pool.query("SELECT id FROM conversations WHERE script_id = $1", [scriptId]),
    pool.query(
      `SELECT m.id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.script_id = $1`,
      [scriptId],
    ),
    pool.query("SELECT id FROM script_versions WHERE script_id = $1", [scriptId]),
  ]);

  return {
    scripts: scripts.rows.length,
    conversations: conversations.rows.length,
    messages: messages.rows.length,
    versions: versions.rows.length,
  };
}

function del(id: string, body?: unknown) {
  return callRoute(
    (request: Parameters<typeof deleteScript>[0]) => deleteScript(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}`, "DELETE", body),
  );
}

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY ??= "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL ??= "anthropic/claude-sonnet-5.5";
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("DELETE /api/scripts/{id}", () => {
  it("removes the script, its conversation, its messages, and its revisions together", async () => {
    const doomed = await create("Doomed");
    const kept = await create("Kept");
    await seedUsage(doomed, "doomed");
    await seedUsage(kept, "kept");

    expect(await rowsOwnedBy(doomed)).toEqual({
      scripts: 1,
      conversations: 1,
      messages: 2,
      versions: 2,
    });

    const response = await del(doomed, { confirm: true });

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    expect(await rowsOwnedBy(doomed)).toEqual({
      scripts: 0,
      conversations: 0,
      messages: 0,
      versions: 0,
    });

    // The sibling is untouched: deletion is scoped to the named script.
    expect(await rowsOwnedBy(kept)).toEqual({
      scripts: 1,
      conversations: 1,
      messages: 2,
      versions: 2,
    });
  });

  it("removes nothing and returns 400 confirmation_required without confirm: true", async () => {
    const id = await create("Guarded");
    await seedUsage(id, "guarded");

    for (const body of [undefined, {}, { confirm: false }, { confirm: "true" }]) {
      const response = await del(id, body);

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("confirmation_required");
    }

    expect(await rowsOwnedBy(id)).toEqual({
      scripts: 1,
      conversations: 1,
      messages: 2,
      versions: 2,
    });
  });

  it("removes a script that was never used", async () => {
    const id = await create("Fresh");

    const response = await del(id, { confirm: true });

    expect(response.status).toBe(204);
    expect(await rowsOwnedBy(id)).toEqual({
      scripts: 0,
      conversations: 0,
      messages: 0,
      versions: 0,
    });
  });

  it("returns a distinguishable not-found error for an unknown id", async () => {
    const response = await del("00000000-0000-4000-8000-000000000000", { confirm: true });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("reports a malformed id as not found rather than leaking a driver error", async () => {
    const response = await del("not-a-uuid", { confirm: true });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
    expect(response.text).not.toMatch(/syntax|uuid|invalid input/i);
  });

  it("does not resurrect or alter another script when the deleted one is requested twice", async () => {
    const id = await create("Twice");
    const other = await create("Other");
    await seedUsage(other, "other");

    expect((await del(id, { confirm: true })).status).toBe(204);
    expect((await del(id, { confirm: true })).status).toBe(404);

    expect(await rowsOwnedBy(other)).toEqual({
      scripts: 1,
      conversations: 1,
      messages: 2,
      versions: 2,
    });
  });
});
