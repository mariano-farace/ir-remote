import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PUT as putContent } from "@/app/api/scripts/[id]/content/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Autosave (FR-004, FR-005, FR-019, FR-020): `PUT /api/scripts/{id}/content`.
 *
 * Two guarantees are asserted here because both are easy to lose silently:
 * a write records the content it superseded *before* it lands, so undo always
 * has a target; and a write based on a stale `baseUpdatedAt` is refused rather
 * than overwriting a newer version (Principle III's reconciliation rule).
 */

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

function params(id: string): Params {
  return { params: Promise.resolve({ id }) };
}

async function create(title: string) {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest("http://localhost:3000/api/scripts", "POST", { title }),
  );

  const data = field(response.json, "data");

  // The precondition is the *script's* `updatedAt`; creation returns no such
  // field, and `createdAt` of the script's row is the value the first save
  // must echo. The conversation's `createdAt` is a different object's field.
  const stored = await getTestPool().query<{ updated_at: string }>(
    "SELECT updated_at::text AS updated_at FROM scripts WHERE id = $1",
    [field(data, "id")],
  );

  return {
    id: field(data, "id") as string,
    updatedAt: new Date(stored.rows[0]?.updated_at ?? "").toISOString(),
  };
}

async function storedScript(id: string) {
  const result = await getTestPool().query<{ content: string; updated_at: Date }>(
    "SELECT content, updated_at FROM scripts WHERE id = $1",
    [id],
  );

  return result.rows[0];
}

async function versionsOf(id: string) {
  const result = await getTestPool().query<{ content: string; origin: string }>(
    "SELECT content, origin FROM script_versions WHERE script_id = $1 ORDER BY created_at, id",
    [id],
  );

  return result.rows;
}

function put(id: string, body: unknown) {
  return callRoute(
    (request: Parameters<typeof putContent>[0]) => putContent(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}/content`, "PUT", body),
  );
}

/** Gives a script some content through the normal route and returns the new updatedAt. */
async function save(id: string, content: string, baseUpdatedAt: string) {
  const response = await put(id, { content, baseUpdatedAt });

  return field(field(response.json, "data"), "updatedAt") as string;
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

describe("PUT /api/scripts/{id}/content", () => {
  it("writes a revision of the prior content before applying the new content", async () => {
    const { id, updatedAt } = await create("The Salt Roads");
    const first = "First paragraph.";
    const second = "Second paragraph.";

    // Establish a prior version, then replace it through the same route.
    const afterFirst = await save(id, first, updatedAt);
    const response = await put(id, { content: second, baseUpdatedAt: afterFirst });

    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "updatedAt")).toEqual(expect.any(String));

    const stored = await storedScript(id);

    expect(stored?.content).toBe(second);

    const versions = await versionsOf(id);

    // Each write records the content it superseded: the empty document, then
    // `first`. A version therefore always holds what the save replaced.
    expect(versions.map((version) => version.content)).toEqual(["", first]);
    expect(versions.every((version) => version.origin === "user")).toBe(true);
  });

  it("records the empty starting document as the first version of a new script", async () => {
    const { id, updatedAt } = await create("The Salt Roads");

    await save(id, "A first draft.", updatedAt);

    expect((await versionsOf(id)).map((version) => version.content)).toEqual([""]);
  });

  it("returns the new updatedAt, and the next save can use it as its base", async () => {
    const { id, updatedAt } = await create("The Salt Roads");

    const afterFirst = await save(id, "One.", updatedAt);
    const response = await put(id, { content: "One. Two.", baseUpdatedAt: afterFirst });

    expect(response.status).toBe(200);

    const stored = await storedScript(id);

    expect(stored?.content).toBe("One. Two.");
    expect(
      new Date(field(field(response.json, "data"), "updatedAt") as string).getTime(),
    ).toBe(new Date(stored?.updated_at ?? 0).getTime());
  });

  it("refuses a write whose baseUpdatedAt is behind the stored value with 409 stale_write", async () => {
    const { id, updatedAt } = await create("The Salt Roads");
    const afterFirst = await save(id, "The version the other tab has.", updatedAt);

    // A second writer moves the script on.
    await save(id, "The version the other tab does not have.", afterFirst);

    // The first writer now saves against the stale base.
    const response = await put(id, {
      content: "The first tab's overwrite.",
      baseUpdatedAt: afterFirst,
    });

    expect(response.status).toBe(409);
    expect(errorCode(response.json)).toBe("stale_write");

    // Neither the content nor the history moved.
    expect((await storedScript(id))?.content).toBe(
      "The version the other tab does not have.",
    );
    expect((await versionsOf(id)).map((version) => version.content)).toEqual([
      "",
      "The version the other tab has.",
    ]);
  });

  it("accepts a write that is identical to the stored content", async () => {
    const { id, updatedAt } = await create("The Salt Roads");

    const response = await put(id, { content: "", baseUpdatedAt: updatedAt });

    expect(response.status).toBe(200);
  });

  it("rejects a request without a baseUpdatedAt", async () => {
    const { id } = await create("The Salt Roads");

    const response = await put(id, { content: "Text." });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("invalid_request");
  });

  it("rejects a non-string content field", async () => {
    const { id, updatedAt } = await create("The Salt Roads");

    const response = await put(id, { content: 42, baseUpdatedAt: updatedAt });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("invalid_request");
  });

  it("returns not_found for a script that does not exist", async () => {
    const response = await put("4d1c8e5a-0000-4000-8000-000000000000", {
      content: "Text.",
      baseUpdatedAt: new Date().toISOString(),
    });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("returns not_found for a malformed id rather than a server fault", async () => {
    const response = await put("not-a-uuid", {
      content: "Text.",
      baseUpdatedAt: new Date().toISOString(),
    });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });
});
