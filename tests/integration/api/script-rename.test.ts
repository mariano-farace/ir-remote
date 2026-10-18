import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PATCH as patchScript } from "@/app/api/scripts/[id]/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Renaming a script (FR-001c): `PATCH /api/scripts/{id}`.
 *
 * A rename is subject to the same rules as creation (FR-001b): non-blank, at
 * most 200 characters, and unique when compared case-insensitively on the
 * trimmed value. Each rule has to be rejected with a message that says which
 * one broke, and a rejected rename leaves the stored title exactly as it was.
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

function patch(id: string, body: unknown) {
  return callRoute(
    (request: Parameters<typeof patchScript>[0]) => patchScript(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}`, "PATCH", body),
  );
}

async function storedTitle(id: string): Promise<string | undefined> {
  const result = await getTestPool().query<{ title: string }>(
    "SELECT title FROM scripts WHERE id = $1",
    [id],
  );

  return result.rows[0]?.title;
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

describe("PATCH /api/scripts/{id}", () => {
  it("renames a script and returns its id, new title, and updatedAt", async () => {
    const id = await create("Working title");

    const response = await patch(id, { title: "The Salt Roads" });

    expect(response.status).toBe(200);

    const data = field(response.json, "data");

    expect(field(data, "id")).toBe(id);
    expect(field(data, "title")).toBe("The Salt Roads");
    expect(field(data, "updatedAt")).toEqual(expect.any(String));
    expect(await storedTitle(id)).toBe("The Salt Roads");
  });

  it("stores the trimmed title", async () => {
    const id = await create("Working title");

    const response = await patch(id, { title: "  Trimmed on both sides  " });

    expect(field(field(response.json, "data"), "title")).toBe("Trimmed on both sides");
    expect(await storedTitle(id)).toBe("Trimmed on both sides");
  });

  it("rejects a blank or missing title with 400 title_required and changes nothing", async () => {
    const id = await create("Working title");

    for (const body of [{ title: "   " }, {}, { title: 42 }]) {
      const response = await patch(id, body);

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("title_required");
    }

    expect(await storedTitle(id)).toBe("Working title");
  });

  it("rejects a title over 200 characters with 400 title_required", async () => {
    const id = await create("Working title");

    const response = await patch(id, { title: "a".repeat(201) });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("title_required");
    expect(await storedTitle(id)).toBe("Working title");
  });

  it("accepts a title of exactly 200 characters", async () => {
    const id = await create("Working title");

    const response = await patch(id, { title: "b".repeat(200) });

    expect(response.status).toBe(200);
    expect(await storedTitle(id)).toBe("b".repeat(200));
  });

  it("rejects a duplicate title case-insensitively on the trimmed value with 409 title_taken", async () => {
    const id = await create("Working title");
    await create("My Film");

    const response = await patch(id, { title: "  my FILM  " });

    expect(response.status).toBe(409);
    expect(errorCode(response.json)).toBe("title_taken");
    expect(await storedTitle(id)).toBe("Working title");
  });

  it("renaming a script to its own title under a different case or spacing is a no-op success", async () => {
    const id = await create("The Salt Roads");

    const response = await patch(id, { title: "  the salt roads  " });

    // Its own title is not a duplicate of itself, so the rename succeeds and
    // stores the trimmed value the user supplied.
    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "title")).toBe("the salt roads");
    expect(await storedTitle(id)).toBe("the salt roads");
  });

  it("returns a distinguishable not-found error for an unknown id", async () => {
    const response = await patch("00000000-0000-4000-8000-000000000000", {
      title: "Anything",
    });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("reports a malformed id as not found rather than leaking a driver error", async () => {
    const response = await patch("not-a-uuid", { title: "Anything" });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
    expect(response.text).not.toMatch(/syntax|uuid|invalid input/i);
  });

  it("does not touch the document's content or history", async () => {
    const id = await create("Working title");
    await getTestPool().query("UPDATE scripts SET content = $2 WHERE id = $1", [
      id,
      "The script itself.",
    ]);

    await patch(id, { title: "Renamed" });

    const stored = await getTestPool().query<{ content: string }>(
      "SELECT content FROM scripts WHERE id = $1",
      [id],
    );
    const versions = await getTestPool().query(
      "SELECT id FROM script_versions WHERE script_id = $1",
      [id],
    );

    expect(stored.rows[0]?.content).toBe("The script itself.");
    expect(versions.rows).toHaveLength(0);
  });
});
