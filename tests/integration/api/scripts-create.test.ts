import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listScripts, POST as createScript } from "@/app/api/scripts/route";
import { TITLE_MAX_LENGTH } from "@/lib/domain/title";

import { callRoute, errorCode, errorMessage, field, jsonRequest } from "../support/api";
import {
  closeTestDatabase,
  firstStyleId,
  getTestPool,
  resetDatabase,
} from "../support/fixtures";

/**
 * `POST /api/scripts` (contracts/http-api.md). The script and its conversation
 * are created atomically, and title rules surface as *distinct* error codes so
 * the UI can tell the user which rule broke (FR-001b).
 */

const URL = "http://localhost:3000/api/scripts";

async function create(body: unknown) {
  return callRoute(createScript, jsonRequest(URL, "POST", body));
}

beforeAll(async () => {
  // Route handlers read configuration through the same startup validation the
  // server uses; the values here never leave the process.
  process.env.OPENROUTER_API_KEY = "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("POST /api/scripts", () => {
  it("creates a script and its conversation, returning 201", async () => {
    const styleId = await firstStyleId();

    const response = await create({ title: "  The Bronze Age  ", styleId });

    expect(response.status).toBe(201);
    expect(field(response.json, "data")).toMatchObject({
      title: "The Bronze Age",
      content: "",
      styleId,
    });
    expect(typeof field(field(response.json, "data"), "id")).toBe("string");
    expect(typeof field(field(response.json, "data"), "conversationId")).toBe("string");
  });

  it("defaults to the first style in the catalogue when none is chosen", async () => {
    const response = await create({ title: "No Style Chosen" });

    expect(response.status).toBe(201);
    expect(field(field(response.json, "data"), "styleId")).toBe(await firstStyleId());
  });

  it("creates exactly one conversation for the new script", async () => {
    const created = await create({ title: "One Conversation" });
    const id = field(field(created.json, "data"), "id");

    const result = await getTestPool().query<{ count: string }>(
      "SELECT count(*) FROM conversations WHERE script_id = $1",
      [id],
    );

    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  describe("title rules", () => {
    it("rejects a blank title with 400 title_required and creates nothing", async () => {
      const response = await create({ title: "   " });

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("title_required");

      const count = await getTestPool().query<{ count: string }>(
        "SELECT count(*) FROM scripts",
      );

      expect(Number(count.rows[0]?.count)).toBe(0);
    });

    it("rejects a missing title with 400 title_required, never inventing one", async () => {
      const response = await create({});

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("title_required");
    });

    it("rejects a title over 200 characters with 400 title_required", async () => {
      const response = await create({ title: "a".repeat(TITLE_MAX_LENGTH + 1) });

      expect(response.status).toBe(400);
      expect(errorCode(response.json)).toBe("title_required");
      expect(String(errorMessage(response.json))).toMatch(/200/);

      const count = await getTestPool().query<{ count: string }>(
        "SELECT count(*) FROM scripts",
      );

      expect(Number(count.rows[0]?.count)).toBe(0);
    });

    it("accepts a title of exactly 200 characters", async () => {
      const response = await create({ title: "a".repeat(TITLE_MAX_LENGTH) });

      expect(response.status).toBe(201);
    });

    it("rejects a duplicate title differing only in case and whitespace with 409 title_taken", async () => {
      await create({ title: "My Film" });

      const response = await create({ title: "  my FILM " });

      expect(response.status).toBe(409);
      expect(errorCode(response.json)).toBe("title_taken");
    });

    it("tells the user which rule broke, so blank and duplicate are distinguishable", async () => {
      await create({ title: "Taken" });

      const blank = await create({ title: "" });
      const taken = await create({ title: "Taken" });

      expect(errorCode(blank.json)).not.toBe(errorCode(taken.json));
      expect(errorMessage(blank.json)).not.toBe(errorMessage(taken.json));
    });
  });

  it("rejects an unknown style with a visible, actionable error", async () => {
    const response = await create({ title: "Bad Style", styleId: "no-such-style" });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("invalid_style");
    expect(errorMessage(response.json)).toMatch(/not in the catalogue/);
  });

  it("rejects a body that is not JSON without creating a script", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    const response = await callRoute(createScript, request as never);

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("invalid_request");
  });

  it("never exposes style guidance in its response (FR-011)", async () => {
    const guidance = await getTestPool().query<{ guidance: string }>(
      "SELECT guidance FROM styles ORDER BY display_order LIMIT 1",
    );

    const response = await create({ title: "Nothing Leaks" });

    expect(response.text).not.toContain(String(guidance.rows[0]?.guidance));
  });

  it("lists the newly created script in GET /api/scripts", async () => {
    await create({ title: "Freshly Made" });

    const response = await callRoute(listScripts, jsonRequest(URL, "GET"));

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ data: [{ title: "Freshly Made" }] });
  });

  it("lists every script ordered by last modification, most recent first (FR-002)", async () => {
    await create({ title: "First Written" });
    await create({ title: "Second Written" });
    await create({ title: "Third Written" });

    const response = await callRoute(listScripts, jsonRequest(URL, "GET"));

    expect(response.status).toBe(200);
    expect(field(response.json, "data")).toEqual([
      expect.objectContaining({ title: "Third Written" }),
      expect.objectContaining({ title: "Second Written" }),
      expect.objectContaining({ title: "First Written" }),
    ]);
  });
});
