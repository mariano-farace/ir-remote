import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as createScriptAtCollection } from "@/app/api/scripts/route";
import { checkTitle } from "@/lib/domain/title";
import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";

import { callRoute, errorCode, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * A script cannot exist without a title the user supplied (FR-001, FR-001a,
 * FR-001c).
 *
 * There is no default and no invented name: not an empty one, not one derived
 * from the script's id, not the first line the user happens to type later.
 */

const scripts = new PostgresScriptRepository();

async function create(body: unknown) {
  return callRoute(
    createScriptAtCollection,
    jsonRequest("http://localhost:3000/api/scripts", "POST", body),
  );
}

async function titles(): Promise<string[]> {
  const result = await getTestPool().query<{ title: string }>(
    "SELECT title FROM scripts",
  );

  return result.rows.map((row) => row.title);
}

beforeEach(async () => {
  await resetDatabase();
  process.env.OPENROUTER_API_KEY ??= "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL ??= "anthropic/claude-sonnet-5.5";
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("creating a script without a title", () => {
  it("cannot complete when the title is absent, and never invents one", async () => {
    const response = await create({});

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("title_required");
    expect(await titles()).toEqual([]);
  });

  it("cannot complete when the title is null, blank, or only whitespace", async () => {
    for (const title of [null, "", "   ", "\t\n"]) {
      const response = await create({ title });

      expect(errorCode(response.json)).toBe("title_required");
    }

    expect(await titles()).toEqual([]);
  });

  it("keeps the user's own title, trimmed, rather than substituting one", async () => {
    const response = await create({ title: "  Lantern Roads  " });

    expect(response.status).toBe(201);
    expect(await titles()).toEqual(["Lantern Roads"]);
  });

  it("has no title rule that accepts an empty result", () => {
    // The domain's own answer is the authority the route reads.
    expect(checkTitle("")).toEqual({ valid: false, rule: "blank" });
    expect(checkTitle(" \n ")).toEqual({ valid: false, rule: "blank" });
  });

  it("applies the same rules to a rename (FR-001c)", async () => {
    const created = await scripts.create({
      title: "Lantern Roads",
      styleId: null,
    });

    await expect(scripts.rename(created.script.id, "  ")).rejects.toMatchObject({
      code: "title_required",
    });

    // And the stored title is untouched by the refused rename.
    expect(await titles()).toEqual(["Lantern Roads"]);
  });
});
