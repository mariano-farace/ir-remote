import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getScript } from "@/app/api/scripts/[id]/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Opening a script (FR-003): the editor fills from the stored document and the
 * chat panel learns which conversation belongs to that script. Loading a
 * script is not a place where one script's data can surface under another id.
 */

interface Params {
  readonly params: Promise<{ id: string }>;
}

async function create(title: string) {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest("http://localhost:3000/api/scripts", "POST", { title }),
  );

  return field(field(response.json, "data"), "id") as string;
}

function get(id: string) {
  const request = jsonRequest(`http://localhost:3000/api/scripts/${id}`, "GET");

  return callRoute(
    (req: Parameters<typeof getScript>[0]) => getScript(req, params(id)),
    request,
  );
}

function params(id: string): Params {
  return { params: Promise.resolve({ id }) };
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

describe("GET /api/scripts/{id}", () => {
  it("returns the script with its own document and the id of its conversation", async () => {
    const id = await create("The Salt Roads");
    const conversation = await getTestPool().query(
      "SELECT id FROM conversations WHERE script_id = $1",
      [id],
    );

    const response = await get(id);
    const data = field(response.json, "data");

    expect(response.status).toBe(200);
    expect(field(data, "id")).toBe(id);
    expect(field(data, "title")).toBe("The Salt Roads");
    expect(field(data, "content")).toBe("");
    expect(field(data, "conversationId")).toBe(conversation.rows[0]?.id);
  });

  it("returns the stored document, not an empty one", async () => {
    const id = await create("With Text");
    await getTestPool().query("UPDATE scripts SET content = $2 WHERE id = $1", [
      id,
      "# Written earlier\n\nThe road was salt.",
    ]);

    const response = await get(id);

    expect(field(field(response.json, "data"), "content")).toBe(
      "# Written earlier\n\nThe road was salt.",
    );
  });

  it("never returns another script's document", async () => {
    const first = await create("First");
    const second = await create("Second");
    await getTestPool().query("UPDATE scripts SET content = $2 WHERE id = $1", [
      first,
      "First script text.",
    ]);
    await getTestPool().query("UPDATE scripts SET content = $2 WHERE id = $1", [
      second,
      "Second script text.",
    ]);

    const response = await get(second);

    expect(field(field(response.json, "data"), "content")).toBe("Second script text.");
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
