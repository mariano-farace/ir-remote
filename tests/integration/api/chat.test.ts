import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresScriptRepository } from "@/lib/repositories/postgres/script-repository";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { callRoute, errorCode, jsonRequest } from "../support/api";
import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

/**
 * `POST /api/chat` (contracts/http-api.md, FR-012, FR-014, FR-016, FR-018).
 *
 * The model is replaced by a scripted response. What matters is what the route
 * does *around* the model: it loads the document and style server-side, builds
 * the prompt fresh from them, streams the assistant turn, and persists only the
 * assistant's summary — never the script body as a chat message.
 */

/** Scripted model output: which tool call to emit, or plain text, or nothing. */
type Scripted =
  | { readonly toolCall: Record<string, unknown> }
  | { readonly text: string }
  | { readonly nothing: true };

const scripted: { current: Scripted } = { current: { text: "Hello." } };
const prompts: { system: string; messages: Array<{ role: string; content: unknown }> }[] =
  [];

function scriptedModel() {
  return {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "scripted/model",
    supportedUrls: {},
    doStream: async (options: {
      prompt: Array<{ role: string; content: unknown }>;
    }): Promise<{ stream: ReadableStream<Record<string, unknown>> }> => {
      const systemMessage = options.prompt.find((message) => message.role === "system");

      prompts.push({
        system: String(systemMessage?.content ?? ""),
        messages: options.prompt.filter((message) => message.role !== "system"),
      });

      const choice = scripted.current;
      const finish = { unified: "stop", raw: "stop" } as const;
      const chunks: Array<Record<string, unknown>> = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "" },
        { type: "text-end", id: "text-1" },
      ];

      if ("toolCall" in choice) {
        chunks.push(
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "apply_document_revision",
            // An argument object the tool's schema rejects arrives exactly
            // like a valid one; the SDK surfaces the run as the streamed
            // "An error occurred." the user sees.
            input: JSON.stringify(choice.toolCall),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
          },
        );
      } else if ("text" in choice) {
        // A second text block carries the visible reply.
        chunks.push(
          { type: "text-start", id: "text-2" },
          { type: "text-delta", id: "text-2", delta: choice.text },
          { type: "text-end", id: "text-2" },
          { type: "finish", finishReason: finish, usage },
        );
      } else {
        chunks.push({ type: "finish", finishReason: finish, usage });
      }

      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }

            controller.close();
          },
        }),
      };
    },
  };
}

vi.mock("@/lib/ai/provider", () => ({
  createScriptModel: () => scriptedModel(),
}));

/** The v4 protocol's usage object. */
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const { POST: chat } = await import("@/app/api/chat/route");

const scripts = new PostgresScriptRepository();
const styles = new PostgresStyleRepository();

const URL = "http://localhost:3000/api/chat";
const DRAFT = "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.";

async function newScript(title: string, content = "") {
  const styleId = (await styles.list())[0]?.id ?? null;
  const created = await scripts.create({ title, styleId, content });

  return created;
}

async function send(body: unknown) {
  return callRoute(chat, jsonRequest(URL, "POST", body));
}

/**
 * Decodes an SSE body into the chunks' payloads.
 *
 * The route is invoked directly with a bare `Request`, so the response has no
 * `x-vercel-ai-ui-message-stream` header for `readUIMessageStream` to key on;
 * the chunks are read here instead. Each chunk's meaning was already fixed by
 * the SDK's `toUIMessageStream`; this only avoids re-decoding SSE in the test.
 */
async function streamChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();

  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
}

function part(chunks: Array<Record<string, unknown>>, type: string) {
  return chunks.find((chunk) => chunk.type === type);
}

const WHOLESALE = {
  targetRegion: { wholeDocument: true },
  expectedText: "",
  replacementText: DRAFT,
  isWholesaleDraft: true,
  summary: "Wrote a first draft about the Bronze Age collapse.",
};

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-integration-test-key";
  process.env.OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
});

beforeEach(async () => {
  await resetDatabase();
  prompts.length = 0;
  scripted.current = { text: "Hello." };
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("POST /api/chat", () => {
  it("rejects a malformed request with the error envelope", async () => {
    const response = await send({ message: "Hello" });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("invalid_request");
  });

  it("rejects an unknown script", async () => {
    const response = await send({
      scriptId: "00000000-0000-4000-8000-000000000000",
      conversationId: "00000000-0000-4000-8000-000000000001",
      message: "Write about salt.",
    });

    expect(response.status).toBe(404);
    expect(errorCode(response.json)).toBe("not_found");
  });

  it("rejects a conversation that does not belong to the script", async () => {
    const first = await newScript("First");
    const second = await newScript("Second");

    const response = await send({
      scriptId: first.script.id,
      conversationId: second.conversation.id,
      message: "Write about salt.",
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe("conversation_mismatch");
  });

  it("loads the document and style server-side, ignoring any the client sends (FR-014)", async () => {
    const created = await newScript("Has Draft", DRAFT);

    await send({
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      message: "Tighten the opening.",
      document: "CLIENT-SUPPLIED TEXT",
    });

    expect(prompts.at(-1)?.system).toContain(DRAFT);
    expect(prompts.at(-1)?.system).not.toContain("CLIENT-SUPPLIED TEXT");
  });

  it("keeps the style guidance in the system prompt and out of the messages (FR-011)", async () => {
    const created = await newScript("Styled");
    const [style] = await styles.list();

    await send({
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      message: "Write about the Bronze Age.",
    });

    const last = prompts.at(-1);

    expect(last?.system).toContain(String(style?.guidance));
    expect(JSON.stringify(last?.messages)).not.toContain(String(style?.guidance));
  });

  it("persists the user's message immediately (FR-003)", async () => {
    const created = await newScript("Persisted");

    await send({
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      message: "Write about salt roads.",
    });

    const rows = await getTestPool().query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
      [created.conversation.id],
    );

    expect(rows.rows[0]).toEqual({ role: "user", content: "Write about salt roads." });
  });

  it("accepts the body a DefaultChatTransport sends, taking the prompt from the last user turn", async () => {
    // `useChat` with a DefaultChatTransport posts the whole conversation, not a
    // `message` field. The route must read the prompt from that body, or every
    // send from the real chat panel is refused as malformed.
    const created = await newScript("Transport Body");

    const response = await send({
      id: "chat-1",
      trigger: "submit-message",
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Write about salt roads." }],
        },
      ],
    });

    expect(response.status).toBe(200);

    const rows = await getTestPool().query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
      [created.conversation.id],
    );

    expect(rows.rows[0]).toEqual({ role: "user", content: "Write about salt roads." });
  });

  it("fails a malformed tool call visibly and logs the cause, leaving the script alone", async () => {
    // A model that omits `targetRegion` produces a call the schema refuses.
    // Nothing can be safely inferred for every such call, so the turn fails
    // with a visible error (Principle IV) and the cause, which the stream
    // reduces to "An error occurred.", is kept on the server.
    scripted.current = {
      toolCall: { isWholesaleDraft: true, expectedText: "", replacementText: "# X" },
    };
    const created = await newScript("Broken Call");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const chunks = await streamChunks(
        await chat(
          jsonRequest(URL, "POST", {
            scriptId: created.script.id,
            conversationId: created.conversation.id,
            message: "Draft something.",
          }),
        ),
      );

      // The assistant turn ends in an error the chat panel renders; the script
      // itself is untouched.
      expect(
        chunks.find((chunk) => chunk.type === "tool-output-available"),
      ).toBeUndefined();
      expect(chunks.find((chunk) => chunk.type === "tool-output-error")).toBeTruthy();
      expect(chunks.at(-1)).toMatchObject({ type: "finish" });

      const details = logged.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
      expect(details).toMatch(/targetRegion/);

      const stored = await scripts.get(created.script.id);
      expect(stored.content).toBe("");
    } finally {
      logged.mockRestore();
    }
  });

  it("streams the tool call as a tool part of the assistant message (FR-016)", async () => {
    scripted.current = { toolCall: WHOLESALE };
    const created = await newScript("First Draft");

    const chunks = await streamChunks(
      await chat(
        jsonRequest(URL, "POST", {
          scriptId: created.script.id,
          conversationId: created.conversation.id,
          message: "Write about the Bronze Age collapse.",
        }),
      ),
    );

    expect(part(chunks, "tool-input-available")).toMatchObject({
      toolName: "apply_document_revision",
      input: { isWholesaleDraft: true },
    });
    expect(part(chunks, "tool-output-available")).toMatchObject({
      output: { applied: true, content: DRAFT },
    });
  });

  it("persists the assistant's summary, never the script body (FR-016)", async () => {
    scripted.current = { toolCall: WHOLESALE };
    const created = await newScript("Summary Only");

    await (
      await chat(
        jsonRequest(URL, "POST", {
          scriptId: created.script.id,
          conversationId: created.conversation.id,
          message: "Write about the Bronze Age collapse.",
        }),
      )
    ).text();

    const rows = await getTestPool().query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
      [created.conversation.id],
    );

    const assistant = rows.rows.find((row) => row.role === "assistant");

    expect(assistant?.content).toBe(WHOLESALE.summary);
    expect(assistant?.content).not.toContain(DRAFT);
  });

  it("does not persist a rejected revision as a change (the document is untouched)", async () => {
    scripted.current = {
      toolCall: { ...WHOLESALE, isWholesaleDraft: false, expectedText: "" },
    };
    const created = await newScript("Non-Empty", DRAFT);

    await send({
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      message: "Rewrite everything.",
    });

    const { content } = await scripts.get(created.script.id);

    expect(content).toBe(DRAFT);
  });

  it("sends no document text and no API key to the client", async () => {
    const created = await newScript("Leak Check", DRAFT);

    const response = await send({
      scriptId: created.script.id,
      conversationId: created.conversation.id,
      message: "What do you think?",
    });

    expect(response.text).not.toContain("sk-or-v1-integration-test-key");
    expect(response.text).not.toContain(String(process.env.OPENROUTER_API_KEY));
  });
});
