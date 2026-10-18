import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { callRoute, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * FR-014, FR-018: every AI request's system prompt is built from the document
 * and style as they are at that moment. A manual edit made between two turns
 * reaches the model on the next one, and a style switched mid-conversation
 * shapes only the turns after it. A prompt cached at module load, at script
 * open, or in a closure would pass a single-request test and fail here.
 */

const captured: string[] = [];

vi.mock("@/lib/ai/provider", () => ({
  createScriptModel: () => ({
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "scripted/model",
    supportedUrls: {},
    doStream: async (options: {
      prompt: Array<{ role: string; content: unknown }>;
    }): Promise<{ stream: ReadableStream<Record<string, unknown>> }> => {
      const system = options.prompt.find((message) => message.role === "system");

      captured.push(String(system?.content ?? ""));

      const finish = { unified: "stop", raw: "stop" } as const;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "Noted." });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              finishReason: finish,
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  }),
}));

const { POST: chat } = await import("@/app/api/chat/route");

const scripts = new PostgresScriptRepository();
const styles = new PostgresStyleRepository();

const URL = "http://localhost:3000/api/chat";

async function turn(scriptId: string, conversationId: string, message: string) {
  await callRoute(chat, jsonRequest(URL, "POST", { scriptId, conversationId, message }));

  return captured.at(-1) ?? "";
}

async function saveText(scriptId: string, content: string): Promise<void> {
  // The user's own write path: the same repository call the save endpoint makes.
  const current = await scripts.get(scriptId);

  await scripts.updateContent(scriptId, content, current.updatedAt, "user");
}

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY ??= "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL ??= "anthropic/claude-sonnet-5.5";
});

beforeEach(async () => {
  captured.length = 0;
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("the system prompt is rebuilt for every request", () => {
  it("carries a manual edit made between two turns (FR-014, FR-018)", async () => {
    const styleList = await styles.list();
    const created = await scripts.create({
      title: "Freshness",
      styleId: styleList[0]?.id ?? null,
      content: "# First draft\n\nThe original opening line.",
    });

    const first = await turn(created.script.id, created.conversation.id, "Tighten it.");

    expect(first).toContain("The original opening line.");

    await saveText(
      created.script.id,
      "# First draft\n\nThe opening line, rewritten by hand.",
    );

    const second = await turn(
      created.script.id,
      created.conversation.id,
      "Tighten it again.",
    );

    expect(second).toContain("The opening line, rewritten by hand.");
    expect(second).not.toContain("The original opening line.");
  });

  it("carries a style switched mid-conversation, and only from that point on (FR-018)", async () => {
    const [first, second] = await styles.list();
    const created = await scripts.create({
      title: "Restyled",
      styleId: first?.id ?? null,
      content: "# Draft\n\nSome text.",
    });

    const before = await turn(created.script.id, created.conversation.id, "Keep going.");
    await scripts.assignStyle(created.script.id, String(second?.id));
    const after = await turn(created.script.id, created.conversation.id, "Keep going.");

    expect(before).toContain(String(first?.guidance));
    expect(after).toContain(String(second?.guidance));
    expect(after).not.toContain(String(first?.guidance));
    // The transcript is untouched by a style change; only the prompt moved.
    expect(await conversationText(created.conversation.id)).not.toContain(
      String(second?.guidance),
    );
  });

  it("does not reuse a prompt when two scripts interleave turns", async () => {
    const styleList = await styles.list();
    const alpha = await scripts.create({
      title: "Alpha",
      styleId: styleList[0]?.id ?? null,
      content: "Alpha's own text.",
    });
    const beta = await scripts.create({
      title: "Beta",
      styleId: styleList[1]?.id ?? null,
      content: "Beta's own text.",
    });

    const alphaTurn = await turn(alpha.script.id, alpha.conversation.id, "Continue.");
    const betaTurn = await turn(beta.script.id, beta.conversation.id, "Continue.");

    expect(alphaTurn).toContain("Alpha's own text.");
    expect(alphaTurn).not.toContain("Beta's own text.");
    expect(betaTurn).toContain("Beta's own text.");
    expect(betaTurn).not.toContain("Alpha's own text.");
    expect(betaTurn).toContain(String(styleList[1]?.guidance));
  });
});

async function conversationText(conversationId: string): Promise<string> {
  const rows = await getTestPool().query<{ content: string }>(
    "SELECT content FROM messages WHERE conversation_id = $1",
    [conversationId],
  );

  return rows.rows.map((row) => row.content).join("\n");
}
