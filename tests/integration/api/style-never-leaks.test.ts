import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DELETE as deleteScript,
  GET as getScript,
  PATCH as patchScript,
} from "@/app/api/scripts/[id]/route";
import { PUT as putContent } from "@/app/api/scripts/[id]/content/route";
import { GET as getMessages } from "@/app/api/scripts/[id]/messages/route";
import { GET as getRevisions } from "@/app/api/scripts/[id]/revisions/route";
import { PUT as putStyle } from "@/app/api/scripts/[id]/style/route";
import {
  GET as listScripts,
  POST as createScriptAtCollection,
} from "@/app/api/scripts/route";
import { GET as getStyles } from "@/app/api/styles/route";

import { callRoute, jsonRequest, type HandledResponse } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * FR-011: a style's guidance is instructions for the model. It never appears
 * in the conversation the user reads, and — just as important — no endpoint
 * echoes it back, including in error messages. The check runs over every
 * response the API can produce, successes and failures alike, because "it
 * never leaks" has to hold for each of them.
 */

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

function params(id: string): Params {
  return { params: Promise.resolve({ id }) };
}

/** The guidance texts as stored, which is what must never come back out. */
async function guidanceTexts(): Promise<string[]> {
  const result = await getTestPool().query<{ guidance: string }>(
    "SELECT guidance FROM styles",
  );

  return result.rows.map((row) => row.guidance).filter((guidance) => guidance.length > 0);
}

/** Every response must be free of every guidance text. */
function expectNoGuidance(response: HandledResponse, guidance: readonly string[]): void {
  for (const text of guidance) {
    expect(response.text).not.toContain(text);
    // The prompt wraps guidance in a labelled block; the label alone would also
    // tell the user the internals exist.
    expect(response.text).not.toContain(text.slice(0, 60));
  }
}

async function create(title: string, styleId?: string): Promise<string> {
  const response = await callRoute(
    createScriptAtCollection,
    jsonRequest(
      "http://localhost:3000/api/scripts",
      "POST",
      styleId === undefined ? { title } : { title, styleId },
    ),
  );

  return (response.json as { data: { id: string } }).data.id;
}

/** Calls an endpoint with an id and method, routing to the right handler. */
async function call(
  handler: typeof getScript,
  id: string,
  method: string,
  body?: unknown,
): Promise<HandledResponse> {
  return callRoute(
    (request: Parameters<typeof getScript>[0]) => handler(request, params(id)),
    jsonRequest(`http://localhost:3000/api/scripts/${id}`, method, body),
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

describe("the style guidance never leaves the server (FR-011)", () => {
  it("is in the database, so the check below is not vacuous", async () => {
    expect(await guidanceTexts()).not.toHaveLength(0);
  });

  it("does not appear in the catalogue, which lists the styles' names only", async () => {
    const guidance = await guidanceTexts();
    const response = await callRoute(
      getStyles,
      jsonRequest("http://localhost:3000/api/styles", "GET"),
    );

    expect(response.status).toBe(200);
    expectNoGuidance(response, guidance);
    expect(response.text).toContain("Historical Documentary");
  });

  it("does not appear in any script response, with or without a style", async () => {
    const guidance = await guidanceTexts();
    const [styleId] = JSON.parse(
      (await callRoute(getStyles, jsonRequest("http://localhost:3000/api/styles", "GET")))
        .text,
    ).data.map((style: { id: string }) => style.id);
    const styled = await create("Styled script", styleId);
    const unstyled = await create("Unstyled script");

    const responses = [
      await callRoute(
        listScripts,
        jsonRequest("http://localhost:3000/api/scripts", "GET"),
      ),
      await call(getScript, styled, "GET"),
      await call(getScript, unstyled, "GET"),
      await call(patchScript, styled, "PATCH", { title: "Renamed script" }),
      await call(putStyle, styled, "PUT", { styleId }),
      await call(putContent, styled, "PUT", {
        content: "Draft text.",
        baseUpdatedAt: new Date(0).toISOString(),
      }),
    ];

    for (const response of responses) {
      expectNoGuidance(response, guidance);
    }
  });

  it("does not appear in a conversation's messages", async () => {
    const guidance = await guidanceTexts();
    const id = await create("Conversation script");

    await getTestPool().query(
      "INSERT INTO messages (conversation_id, role, content) VALUES ((SELECT id FROM conversations WHERE script_id = $1), 'user', 'Write an opening scene.')",
      [id],
    );

    expectNoGuidance(await call(getMessages, id, "GET"), guidance);
  });

  it("does not appear in the revision list", async () => {
    const guidance = await guidanceTexts();
    const id = await create("Revision script");

    expectNoGuidance(await call(getRevisions, id, "GET"), guidance);
  });

  it("does not appear in an error response", async () => {
    const guidance = await guidanceTexts();
    const id = await create("Working title");
    const missing = "00000000-0000-4000-8000-000000000000";

    // Each failure cause the API can report, so none of them can carry the
    // guidance into a message the user reads.
    const cases = {
      "a missing script": await call(getScript, missing, "GET"),
      "a malformed id": await call(getScript, "not-an-id", "GET"),
      "a missing conversation": await call(getMessages, missing, "GET"),
      "an unknown style": await call(putStyle, id, "PUT", { styleId: "no-such-style" }),
      "an empty save": await call(putContent, id, "PUT", {}),
      "a stale save": await call(putContent, id, "PUT", {
        content: "Draft.",
        baseUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
      "a duplicate title": await callRoute(
        createScriptAtCollection,
        jsonRequest("http://localhost:3000/api/scripts", "POST", {
          title: "working TITLE ",
        }),
      ),
      "a deletion with no confirmation": await call(deleteScript, id, "DELETE", {}),
    };

    for (const [cause, response] of Object.entries(cases)) {
      expect({ cause, status: response.status >= 400 }).toEqual({ cause, status: true });
      expectNoGuidance(response, guidance);
    }
  });
});
