import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getMessages } from "@/app/api/scripts/[id]/messages/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * The restored conversation (FR-003, FR-006, SC-003): `GET /api/scripts/{id}/messages`.
 *
 * A reopened script must show exactly the turns that produced it, in the order
 * they happened, and nothing from another script. Both halves are asserted:
 * the right conversation is found from the script id alone (the client must not
 * have to remember a conversation id across sessions), and the ordering holds
 * even for messages written in the same millisecond.
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

async function conversationOf(scriptId: string): Promise<string> {
  const result = await getTestPool().query<{ id: string }>(
    "SELECT id FROM conversations WHERE script_id = $1",
    [scriptId],
  );

  return result.rows[0]?.id ?? "";
}

/** Appends a message directly, the way the chat route's persistence does. */
async function append(
  conversationId: string,
  role: string,
  content: string,
): Promise<void> {
  await getTestPool().query(
    "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
    [conversationId, role, content],
  );
}

function get(scriptId: string) {
  return callRoute(
    (request: Parameters<typeof getMessages>[0]) =>
      getMessages(request, params(scriptId)),
    jsonRequest(`http://localhost:3000/api/scripts/${scriptId}/messages`, "GET"),
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

describe("GET /api/scripts/{id}/messages", () => {
  it("returns the script's own messages in creation order", async () => {
    const id = await create("The Salt Roads");
    const conversationId = await conversationOf(id);

    await append(conversationId, "user", "Write about the salt roads.");
    await append(conversationId, "assistant", "Wrote a first draft.");
    await append(conversationId, "user", "Make the opening colder.");

    const response = await get(id);
    const data = field(response.json, "data") as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(data.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(data.map((message) => message.content)).toEqual([
      "Write about the salt roads.",
      "Wrote a first draft.",
      "Make the opening colder.",
    ]);
    expect(data.every((message) => typeof message.id === "string")).toBe(true);
    expect(data.every((message) => typeof message.createdAt === "string")).toBe(true);
  });

  it("keeps insertion order for messages written in the same millisecond", async () => {
    const id = await create("The Salt Roads");
    const conversationId = await conversationOf(id);

    // A fixed timestamp for every row: `created_at` alone cannot order them,
    // so only the `seq` tiebreak can (db/migrations/0001_initial.sql).
    for (const content of ["one", "two", "three"]) {
      await getTestPool().query(
        `INSERT INTO messages (conversation_id, role, content, created_at)
         VALUES ($1, 'user', $2, '2026-10-17T12:00:00.000Z')`,
        [conversationId, content],
      );
    }

    const response = await get(id);
    const messages = field(response.json, "data") as Array<{ content: string }>;

    expect(messages.map((message) => message.content)).toEqual(["one", "two", "three"]);
  });

  it("never returns another script's messages", async () => {
    const first = await create("First");
    const second = await create("Second");
    await append(await conversationOf(first), "user", "Only about the first.");
    await append(await conversationOf(second), "user", "Only about the second.");

    const response = await get(second);

    expect(field(response.json, "data")).toEqual([
      expect.objectContaining({ role: "user", content: "Only about the second." }),
    ]);
  });

  it("returns an empty list for a script that has not been used yet", async () => {
    const id = await create("Fresh");

    const response = await get(id);

    expect(response.status).toBe(200);
    expect(field(response.json, "data")).toEqual([]);
  });

  it("returns a distinguishable not-found error for an unknown id", async () => {
    const response = await get("00000000-0000-4000-8000-000000000000");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("reports a malformed id as not found rather than leaking a driver error", async () => {
    const response = await get("not-a-uuid");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
    expect(response.text).not.toMatch(/syntax|uuid|invalid input/i);
  });
});
