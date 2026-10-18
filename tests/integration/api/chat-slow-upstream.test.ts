import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { jsonRequest } from "../support/api";
import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * A chat request whose upstream *is* producing output but is slow (FR-023,
 * SC-006, Principle IV).
 *
 * SC-006's "unavailable or slow" means a hung or dead upstream, not a working
 * one that is merely long. A real first draft takes 20–45 s, so a bound that
 * fires while the stream is still producing turns a legitimate generation into
 * a reported timeout — the opposite of what the criterion asks for. This file
 * is the case the 30 s timer destroyed and that no other test covers: the
 * sibling `chat-timeout.test.ts` only ever exercises an upstream that never
 * answers at all.
 *
 * The upstream here paces its chunks so the turn runs well past 30 s and
 * finishes inside 60 s. The clock is simulated, so the test takes milliseconds,
 * and the body is read as a stream so a route that never ends fails on a real
 * assertion instead of hanging the run.
 */

/**
 * How long the fake upstream takes to finish. Past the 30 s bound the route
 * used to enforce, comfortably inside the 60 s bound it must enforce.
 */
const SLOW_TURN_MS = 45_000;

/** How long the fake upstream stays silent between chunks. */
const CHUNK_INTERVAL_MS = 15_000;

const UPSTREAM_TEXT = "Around 1200 BCE, the trade networks fell.";

/** The v4 protocol's usage object; the SDK reads it when the finish arrives. */
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * The upstream's first model call is the one under test. A later call would be
 * a retry the bound must not spend (FR-023), so it is recorded and refused.
 */
const attempts: number[] = [];

/**
 * How the fake upstream behaves. Held in a hoisted object so the module mock
 * can read it while a test switches it — the two halves of FR-023 need opposite
 * upstreams, and a mock created at import time cannot see a per-test choice.
 */
const upstream = vi.hoisted(() => ({
  mode: "slow" as "slow" | "silent",
}));

/** The chunks a v4 stream must carry to be read as an answer at all. */
function openingChunks(): Array<Record<string, unknown>> {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
  ];
}

vi.mock("@/lib/ai/provider", () => ({
  createScriptModel: () => ({
    specificationVersion: "v4",
    provider: "slow-but-succeeds",
    modelId: "slow-but-succeeds/model",
    supportedUrls: {},
    doStream: async () => {
      attempts.push(Date.now());

      // The silent upstream: neither produces nor closes, and ignores any
      // abort — a well-behaved one would hide a bound that is not really
      // enforced. This is the case the 30 s timer was written for, kept here
      // so raising the bound to 60 s cannot be mistaken for removing it.
      if (upstream.mode === "silent") {
        return {
          stream: new ReadableStream<Record<string, unknown>>({ start() {} }),
        };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;

      // Paces a text delta every CHUNK_INTERVAL_MS and closes at SLOW_TURN_MS,
      // well past the 30 s bound the route used to enforce. Chunks follow the
      // v4 protocol in order — `text-start` before its deltas, `text-end`, then
      // `finish` carrying usage — because the SDK reads the sequence, and a
      // malformed one surfaces as an error rather than as the slow answer this
      // file exists to prove.
      const stream = new ReadableStream<Record<string, unknown>>({
        start(controller) {
          for (const chunk of openingChunks()) {
            controller.enqueue(chunk);
          }

          let elapsed = 0;

          const tick = () => {
            if (closed) {
              return;
            }

            elapsed += CHUNK_INTERVAL_MS;
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: UPSTREAM_TEXT.slice(0, 1),
            });

            if (elapsed >= SLOW_TURN_MS) {
              controller.enqueue({ type: "text-end", id: "text-1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              closed = true;
              controller.close();

              return;
            }

            timer = setTimeout(tick, CHUNK_INTERVAL_MS);
          };

          timer = setTimeout(tick, CHUNK_INTERVAL_MS);
        },
        cancel() {
          closed = true;

          if (timer) {
            clearTimeout(timer);
          }
        },
      });

      return { stream };
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
  upstream.mode = "slow";
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("POST /api/chat against a slow upstream that is still producing", () => {
  it("does not abort a turn that runs past 30 seconds but finishes within 60", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });

    try {
      const styleId = (await styles.list())[0]?.id ?? null;
      const created = await scripts.create({
        title: "Slow But Succeeds",
        styleId,
        content: CONTENT,
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const response = await chat(
          jsonRequest(URL, "POST", {
            scriptId: created.script.id,
            conversationId: created.conversation.id,
            message: "Draft the opening.",
          }),
        );

        expect(response.status).toBe(200);
        expect(response.body).not.toBeNull();

        const ended = collect(response.body as ReadableStream<Uint8Array>);
        const startedAt = Date.now();

        // The turn runs well past the 30 s bound that used to cut it off.
        await vi.advanceTimersByTimeAsync(SLOW_TURN_MS - 1);
        expect(attempts).toHaveLength(1);

        // The upstream finishes inside the 60 s bound, and the turn is reported
        // as an answer rather than as a timeout (SC-006, FR-022a).
        await vi.advanceTimersByTimeAsync(2);

        const chunks = await ended;
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThanOrEqual(60_000);
        expect(elapsed).toBeGreaterThan(30_000);
        expect(attempts).toHaveLength(1);

        // The answer reached the client...
        expect(chunks.map((chunk) => chunk.type)).toContain("text-delta");
        // ...and it was never reported as a timeout.
        expect(chunks.map((chunk) => chunk.type)).not.toContain("error");
        expect(JSON.stringify(chunks)).not.toMatch(/60 seconds|timed out|timeout/i);
      } finally {
        logged.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("still reports a timeout within the bound when the upstream never produces output", async () => {
    // The other half of the criterion: the bound must still exist. A silent
    // upstream is the case the 30 s timer was written for, and raising the
    // bound to 60 s must not have removed the enforcement (FR-023).
    upstream.mode = "silent";
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });

    try {
      const styleId = (await styles.list())[0]?.id ?? null;
      const created = await scripts.create({
        title: "Slow Then Silent",
        styleId,
        content: CONTENT,
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const response = await chat(
          jsonRequest(URL, "POST", {
            scriptId: created.script.id,
            conversationId: created.conversation.id,
            message: "Draft the opening.",
          }),
        );

        const ended = collect(response.body as ReadableStream<Uint8Array>);
        const startedAt = Date.now();

        await vi.advanceTimersByTimeAsync(60_000);
        const chunks = await ended;
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThanOrEqual(60_000);
        expect(attempts).toHaveLength(1);
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
