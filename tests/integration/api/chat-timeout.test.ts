import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { jsonRequest } from "../support/api";
import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * A chat request whose upstream never answers (FR-023, SC-006, Principle IV).
 *
 * The bound is the route's own: whatever the model or the network does, the
 * request ends in a reported error within 60 seconds, and the document keeps
 * the text it had. The upstream here never produces a chunk *and* never
 * resolves once aborted — a well-behaved one would hide a bound that is not
 * really enforced.
 *
 * The clock is simulated, so the test takes milliseconds rather than 60
 * seconds, and the response's body is read as a stream so that a route which
 * never ends fails on a real assertion instead of hanging the run.
 */

/** Requests the fake upstream received; the route must not retry a silent one. */
const attempts: number[] = [];

vi.mock("@/lib/ai/provider", () => ({
  createScriptModel: () => ({
    specificationVersion: "v4",
    provider: "never-responds",
    modelId: "never-responds/model",
    supportedUrls: {},
    doStream: async () => {
      attempts.push(Date.now());

      return {
        // Neither produces nor closes, and ignores any abort.
        stream: new ReadableStream<Record<string, unknown>>({ start() {} }),
      };
    },
  }),
}));

const { POST: chat } = await import("@/app/api/chat/route");

const scripts = new PostgresScriptRepository();
const styles = new PostgresStyleRepository();

const URL = "http://localhost:3000/api/chat";
const CONTENT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

interface Chunk {
  readonly type: string;
}

/** Reads a response's chunks until the body ends. */
async function collect(body: ReadableStream<Uint8Array>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  const reader = body.getReader();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return chunks;
    }

    text += new TextDecoder().decode(value);

    for (const frame of text.split("\n\n")) {
      if (frame.startsWith("data: ") && !frame.includes("[DONE]")) {
        const parsed = JSON.parse(frame.slice("data: ".length)) as Chunk;

        if (!chunks.some((chunk) => JSON.stringify(chunk) === JSON.stringify(parsed))) {
          chunks.push(parsed);
        }
      }
    }
  }
}

beforeAll(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
});

beforeEach(async () => {
  await resetDatabase();
  attempts.length = 0;
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("POST /api/chat against an upstream that never responds", () => {
  it("ends in a reported error within 60 seconds and leaves the document unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });

    try {
      const styleId = (await styles.list())[0]?.id ?? null;
      const created = await scripts.create({
        title: "Silent Upstream",
        styleId,
        content: CONTENT,
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const response = await chat(
          jsonRequest(URL, "POST", {
            scriptId: created.script.id,
            conversationId: created.conversation.id,
            message: "Revise the opening.",
          }),
        );

        expect(response.status).toBe(200);
        expect(response.body).not.toBeNull();

        const ended = collect(response.body as ReadableStream<Uint8Array>);
        const startedAt = Date.now();

        // Time passes while the upstream stays silent.
        await vi.advanceTimersByTimeAsync(60_000);
        const chunks = await ended;
        const elapsed = Date.now() - startedAt;

        // Within the bound, and not a second attempt spending another 60 s.
        expect(elapsed).toBeLessThanOrEqual(60_000);
        expect(attempts).toHaveLength(1);
        // Reported as the failure the user is told about (FR-022a), not as an
        // answer and not as the quiet `abort` chunk a stop produces (FR-014b).
        expect(chunks.map((chunk) => chunk.type)).toContain("error");
        expect(JSON.stringify(chunks)).toMatch(/60 seconds/);

        const stored = await scripts.get(created.script.id);
        expect(stored.content).toBe(CONTENT);
      } finally {
        logged.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
