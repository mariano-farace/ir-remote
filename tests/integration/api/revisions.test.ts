import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listRevisions } from "@/app/api/scripts/[id]/revisions/route";
import { POST as restoreRevision } from "@/app/api/scripts/[id]/revisions/[versionId]/restore/route";
import { PUT as putContent } from "@/app/api/scripts/[id]/content/route";
import { GET as getScript } from "@/app/api/scripts/[id]/route";
import { POST as createScriptAtCollection } from "@/app/api/scripts/route";

import { callRoute, errorCode, field, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * Version history and undo (FR-020): listing and restoring revisions.
 *
 * Listing returns previews, never the full document — the undo affordance shows
 * the first 200 characters of each version. Restoring replays a prior version
 * through the same write path as any other change, so the text it replaces is
 * itself recorded first: undo is undoable.
 */

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

interface ListedVersion {
  readonly id: string;
  readonly index: number;
  readonly createdAt: string;
  readonly origin: string;
  readonly preview: string;
}

type ListResponse = readonly ListedVersion[];

async function create(title: string): Promise<ScriptData> {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest("http://localhost:3000/api/scripts", "POST", { title }),
  );

  return field(response.json, "data") as ScriptData;
}

interface ScriptData {
  readonly id: string;
  readonly createdAt: string;
}

/** Saves content and returns the new `updatedAt` the next save must use as its base. */
async function save(id: string, content: string, baseUpdatedAt: string): Promise<string> {
  const response = await callRoute(
    (request: Parameters<typeof putContent>[0]) =>
      putContent(request, { params: Promise.resolve({ id }) }),
    jsonRequest(`http://localhost:3000/api/scripts/${id}/content`, "PUT", {
      content,
      baseUpdatedAt,
    }),
  );

  if (response.status !== 200) {
    throw new Error(`Saving failed with ${response.status}: ${response.text}`);
  }

  return field(field(response.json, "data"), "updatedAt") as string;
}

async function scriptUpdatedAt(id: string): Promise<string> {
  const result = await getTestPool().query<{ updated_at: Date }>(
    "SELECT updated_at FROM scripts WHERE id = $1",
    [id],
  );

  return (result.rows[0]?.updated_at ?? new Date(0)).toISOString();
}

async function prepare(contents: readonly string[]) {
  const { id } = await create("The Salt Roads");

  // The script's own `updatedAt`, which is what a first save echoes. Creation
  // returns the script's `createdAt`; the two share the row's initial stamp.
  const stored = await getTestPool().query<{ updated_at: string }>(
    "SELECT updated_at::text AS updated_at FROM scripts WHERE id = $1",
    [id],
  );

  let base = new Date(stored.rows[0]?.updated_at ?? "").toISOString();

  for (const content of contents) {
    base = await save(id, content, base);
  }

  return { id, updatedAt: base };
}

function list(id: string) {
  return callRoute(
    (request: Parameters<typeof listRevisions>[0]) =>
      listRevisions(request, { params: Promise.resolve({ id }) }),
    jsonRequest(`http://localhost:3000/api/scripts/${id}/revisions`, "GET"),
  );
}

function restore(id: string, versionId: string) {
  const context = { params: Promise.resolve({ id, versionId }) };

  return callRoute(
    (request: Parameters<typeof restoreRevision>[0]) => restoreRevision(request, context),
    jsonRequest(
      `http://localhost:3000/api/scripts/${id}/revisions/${versionId}/restore`,
      "POST",
      {},
    ),
  );
}

function getOne(id: string) {
  return callRoute(
    (request: Parameters<typeof getScript>[0]) =>
      getScript(request, { params: Promise.resolve({ id }) }),
    jsonRequest(`http://localhost:3000/api/scripts/${id}`, "GET"),
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

describe("GET /api/scripts/{id}/revisions", () => {
  it("lists versions newest first with a 1-based chronological index", async () => {
    const { id } = await prepare(["One.", "Two.", "Three."]);

    const response = await list(id);
    const versions = field(response.json, "data") as ListResponse;

    expect(response.status).toBe(200);
    // Three saves record the empty document, "One." and "Two."; a version holds
    // the content its save replaced (data-model.md), so the newest previews
    // are the latest content a user can go back to.
    expect(versions.map((version) => version.index)).toEqual([3, 2, 1]);
    expect(versions.map((version) => version.preview)).toEqual(["Two.", "One.", ""]);
    expect(versions.every((version) => version.origin === "user")).toBe(true);
    expect(versions.every((version) => typeof version.createdAt === "string")).toBe(true);
  });

  it("returns previews rather than full content", async () => {
    const long = `${"a".repeat(200)}${"b".repeat(50)}`;
    // The script's three contents each become a later version's preview.
    const { id } = await prepare([long, "Middle.", "Last."]);

    const versions = field((await list(id)).json, "data") as ListResponse;
    const longVersion = versions.find((version) => version.preview.startsWith("a"));

    expect(longVersion?.preview).toBe("a".repeat(200));
    // The 50 characters beyond the preview never cross the wire.
    expect(versions.every((version) => !version.preview.includes("b"))).toBe(true);
    expect(versions.every((version) => !Object.hasOwn(version, "content"))).toBe(true);
  });

  it("returns an empty list for a script with no changes yet", async () => {
    const { id } = await create("The Salt Roads");

    const response = await list(id);

    expect(response.status).toBe(200);
    expect(field(response.json, "data")).toEqual([]);
  });

  it("returns not_found for an unknown script", async () => {
    const response = await list("4d1c8e5a-0000-4000-8000-000000000000");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });
});

describe("POST /api/scripts/{id}/revisions/{versionId}/restore", () => {
  it("restores a prior version's content and returns it with the new updatedAt", async () => {
    const { id } = await prepare(["Original.", "Edited."]);
    const versions = field((await list(id)).json, "data") as ListResponse;
    const original = versions.find((version) => version.preview === "Original.");

    const response = await restore(id, original?.id ?? "");
    const script = field((await getOne(id)).json, "data");

    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "content")).toBe("Original.");
    expect(field(script, "content")).toBe("Original.");
    expect(field(field(response.json, "data"), "updatedAt")).toBe(
      await scriptUpdatedAt(id),
    );
  });

  it("creates a new revision for the content the restore replaces, so the restore is undoable", async () => {
    const { id } = await prepare(["Original.", "Edited."]);
    const before = field((await list(id)).json, "data") as ListResponse;
    const original = before.find((version) => version.preview === "Original.");

    await restore(id, original?.id ?? "");

    const after = field((await list(id)).json, "data") as ListResponse;

    expect(after).toHaveLength(before.length + 1);
    // The document was "Edited." when the restore ran, so the new, newest
    // version holds exactly that: undoing the restore brings it back.
    expect(after[0]?.preview).toBe("Edited.");
    // And the earlier versions are untouched.
    expect(after.slice(1).map((version) => version.id)).toEqual(
      before.map((version) => version.id),
    );
  });

  it("can restore the pre-restore state, returning the document to where it was", async () => {
    const { id } = await prepare(["Original.", "Edited."]);
    const original = (field((await list(id)).json, "data") as ListResponse).find(
      (version) => version.preview === "Original.",
    );
    await restore(id, original?.id ?? "");

    const undo = (field((await list(id)).json, "data") as ListResponse)[0];
    await restore(id, undo?.id ?? "");

    expect(field(field((await getOne(id)).json, "data"), "content")).toBe("Edited.");
  });

  it("records the restore even when it restores the version already in the document", async () => {
    const { id } = await prepare(["Original."]);
    // "Original." was never replaced, so its own version does not exist; the
    // history holds the empty document it replaced.
    const [only] = field((await list(id)).json, "data") as ListResponse;

    const response = await restore(id, only?.id ?? "");

    expect(response.status).toBe(200);
    expect(field(field(response.json, "data"), "content")).toBe("");
    expect(field((await list(id)).json, "data") as ListResponse).toHaveLength(2);
  });

  it("restores to an earlier version when the list holds several", async () => {
    const { id } = await prepare(["One.", "Two.", "Three."]);
    const two = (field((await list(id)).json, "data") as ListResponse).find(
      (version) => version.preview === "Two.",
    );

    await restore(id, two?.id ?? "");

    expect(field(field((await getOne(id)).json, "data"), "content")).toBe("Two.");
    // The newest version now holds the content the restore replaced.
    expect((field((await list(id)).json, "data") as ListResponse)[0]?.preview).toBe(
      "Three.",
    );
  });

  it("returns not_found for an unknown version", async () => {
    const { id } = await prepare(["Original."]);

    const response = await restore(id, "3c3c3c3c-0000-4000-8000-000000000000");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("returns not_found for a version of a different script, leaving that script untouched", async () => {
    const first = await create("First script");
    await save(first.id, "First script's text.", await scriptUpdatedAt(first.id));
    const second = await create("Second script");
    await save(second.id, "Second script's text.", await scriptUpdatedAt(second.id));
    const foreign = (field((await list(first.id)).json, "data") as ListResponse)[0];

    const response = await restore(second.id, foreign?.id ?? "");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
    expect(field(field((await getOne(second.id)).json, "data"), "content")).toBe(
      "Second script's text.",
    );
    expect(field(field((await getOne(first.id)).json, "data"), "content")).toBe(
      "First script's text.",
    );
  });

  it("returns not_found for a malformed version id", async () => {
    const { id } = await prepare(["Original."]);

    const response = await restore(id, "not-a-uuid");

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });
});
