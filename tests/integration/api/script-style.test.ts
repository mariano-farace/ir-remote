import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getScript } from "@/app/api/scripts/[id]/route";
import { GET as getStyles } from "@/app/api/styles/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Assigning a script's style (T071; FR-008, FR-009, FR-010), US4.
 *
 * Exactly one predefined style may be associated with a script, and selecting
 * one replaces any earlier choice rather than adding a second. The catalogue
 * itself is fixed content: nothing reachable over HTTP can create, edit, or
 * delete a style, and the style in force is reported with the script so the
 * client can show it without guessing.
 *
 * The assignment route is imported without static type information, through the
 * same project alias as everything else: T071 is the test that precedes it
 * (T074), so it does not exist yet, and the failure must be the missing
 * behavior rather than a module-resolution error at collection time or at
 * build type-check time. The assertions still run against the routes that do
 * exist, and every `PUT` assertion fails until T074 adds the route.
 */

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

function params(id: string): Params {
  return { params: Promise.resolve({ id }) };
}

type StyleRoute = (request: Request, context: Params) => Promise<Response>;

async function assignStyleModule(): Promise<{ PUT?: StyleRoute }> {
  // Loaded through the bundler's alias rather than a static import, which is
  // what lets the module not exist yet without failing the build.
  const target: string = "@/app/api/scripts/[id]/style/route";

  try {
    const loaded: unknown = await import(/* @vite-ignore */ target);

    return (typeof loaded === "object" && loaded !== null ? loaded : {}) as {
      PUT?: StyleRoute;
    };
  } catch {
    return {};
  }
}

async function create(title: string, styleId?: string | null): Promise<string> {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest(
      "http://localhost:3000/api/scripts",
      "POST",
      styleId === undefined ? { title } : { title, styleId },
    ),
  );

  return field(field(response.json, "data"), "id") as string;
}

async function assign(id: string, body: unknown) {
  const { PUT } = await assignStyleModule();

  if (PUT === undefined) {
    throw new Error("PUT /api/scripts/{id}/style is not implemented");
  }

  return callRoute(
    (request: Parameters<StyleRoute>[0]) => PUT(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}/style`, "PUT", body),
  );
}

async function open(id: string) {
  return callRoute(
    (request: Parameters<typeof getScript>[0]) => getScript(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}`, "GET"),
  );
}

async function storedStyleId(id: string): Promise<string | null | undefined> {
  const result = await getTestPool().query<{ style_id: string | null }>(
    "SELECT style_id FROM scripts WHERE id = $1",
    [id],
  );

  return result.rows[0]?.style_id;
}

async function catalogueIds(): Promise<string[]> {
  const response = await callRoute(
    getStyles,
    jsonRequest("http://localhost:3000/api/styles", "GET"),
  );

  return ((response.json as { data: Array<{ id: string }> }).data ?? []).map(
    (style) => style.id,
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

describe("PUT /api/scripts/{id}/style", () => {
  it("replaces the previous style rather than adding a second", async () => {
    const [first, second] = await catalogueIds();
    const id = await create("Working title", first);

    const response = await assign(id, { styleId: second });

    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "styleId")).toBe(second);
    expect(await storedStyleId(id)).toBe(second);

    // At most one association exists, and it is the new one: switching back
    // replaces it again rather than leaving history behind.
    const switchedBack = await assign(id, { styleId: first });

    expect(field(field(switchedBack.json, "data"), "styleId")).toBe(first);
    expect(await storedStyleId(id)).toBe(first);
  });

  it("continues to work for a script that started with no style", async () => {
    const [first] = await catalogueIds();
    const id = await create("No style yet");
    await getTestPool().query("UPDATE scripts SET style_id = NULL WHERE id = $1", [id]);

    const response = await assign(id, { styleId: first });

    expect(response.status).toBe(200);
    expect(await storedStyleId(id)).toBe(first);
  });

  it("rejects an unknown styleId with 400 invalid_style and leaves the script unchanged", async () => {
    const [first] = await catalogueIds();
    const id = await create("Working title", first);

    for (const styleId of ["no-such-style", "  ", ""]) {
      const response = await assign(id, { styleId });

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("invalid_style");
    }

    expect(await storedStyleId(id)).toBe(first);
  });

  it("rejects a missing or non-string styleId with 400 invalid_style", async () => {
    const [first] = await catalogueIds();
    const id = await create("Working title", first);

    for (const body of [{}, { styleId: null }, { styleId: 7 }]) {
      const response = await assign(id, body);

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("invalid_style");
    }

    expect(await storedStyleId(id)).toBe(first);
  });

  it("returns a distinguishable not-found error for an unknown script", async () => {
    const [first] = await catalogueIds();

    const response = await assign("00000000-0000-4000-8000-000000000000", {
      styleId: first,
    });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("does not touch the document's content or history", async () => {
    const [first, second] = await catalogueIds();
    const id = await create("Working title", first);
    await getTestPool().query("UPDATE scripts SET content = $2 WHERE id = $1", [
      id,
      "The script itself.",
    ]);

    await assign(id, { styleId: second });

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

describe("the style is reported with the script (FR-010)", () => {
  it("GET /api/scripts/{id} returns the applied style", async () => {
    const [first, second] = await catalogueIds();
    const id = await create("Working title", first);

    await assign(id, { styleId: second });

    const response = await open(id);

    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "styleId")).toBe(second);
  });

  it("GET /api/scripts lists the applied style for each script", async () => {
    const [first, second] = await catalogueIds();
    const id = await create("Working title", first);
    await assign(id, { styleId: second });

    const response = await callRoute(
      (await import("@/app/api/scripts/route")).GET,
      jsonRequest("http://localhost:3000/api/scripts", "GET"),
    );

    const listed =
      (field(response.json, "data") as Array<{ id: string; styleId: unknown }>) ?? [];

    expect(listed.find((script) => script.id === id)?.styleId).toBe(second);
  });
});

describe("styles are read-only (FR-008, FR-009)", () => {
  it("no verb other than GET is handled on the catalogue", async () => {
    // A style is created by the seed, never over HTTP. Declaring only `GET` is
    // what makes Next.js answer every other verb with 405.
    const exports = Object.keys(await import("@/app/api/styles/route")).sort();

    expect(exports).toEqual(["GET"]);
  });

  it("the catalogue endpoint exposes no create, edit, or delete route", async () => {
    const styles = await import("@/app/api/styles/route");
    const exports = Object.keys(styles).sort();

    expect(exports).toEqual(["GET"]);
  });

  it("leaves the catalogue intact after a script changes style", async () => {
    const before = await catalogueIds();
    const [, second] = before;
    const id = await create("Working title", before[0]);

    await assign(id, { styleId: second });

    expect(await catalogueIds()).toEqual(before);
  });
});
