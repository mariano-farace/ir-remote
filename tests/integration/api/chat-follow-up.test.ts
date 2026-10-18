import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { streamText, toUIMessageStream, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createServer } from "node:http";
import { z } from "zod";

/**
 * What happens when the user answers the question a tool call raised (FR-015c).
 *
 * A call that would rewrite a non-empty script is held for the user's answer.
 * The answer arrives as a new request, and `streamText` re-runs the held call
 * itself, before the model is asked the next step. If the re-run does not read
 * the answer as consent, the rewrite the user confirmed is refused as
 * unanswered: the turn ends having done nothing, and the user is told their
 * rewrite "needs confirmation" they have just given.
 *
 * The test drives the SDK exactly as the route does — `streamText` with
 * `toolApproval`, streamed through `toUIMessageStream` — against a scripted
 * OpenRouter, and sends the second request the way the client's
 * `convertToModelMessages` builds it.
 */

interface RecordedMessage {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: string;
}

/** Every request the stub was given, as its messages. */
const requests: RecordedMessage[][] = [];

function chunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "scripted/model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** Its answer to anything after that. */
const REPLY =
  chunk({ role: "assistant", content: "Rewrote the closing paragraph." }, null) +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

async function startUpstream(
  answers: readonly string[] = [REWRITE_CALL, REPLY],
): Promise<{ origin: string; close: () => void }> {
  requests.length = 0;
  const queue = [...answers];

  const server = createServer((request, response) => {
    let raw = "";

    request.on("data", (part: Buffer) => {
      raw += part.toString("utf8");
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as { messages: RecordedMessage[] };

      requests.push(body.messages);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(queue.shift() ?? REPLY);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

const REVISION_TOOL = "apply_document_revision";

describe("a rewrite waiting for the user's answer", () => {
  it("runs the call again once the client sends the answer", async () => {
    // The first request asks; the client's answer arrives as the next one.
    // The SDK re-runs the held call there, and if the answer is not read as
    // consent, a rewrite the user confirmed silently does nothing.
    const upstream = await startUpstream([REWRITE_CALL, REPLY]);

    try {
      const model = createOpenRouter({
        apiKey: "test-key",
        baseURL: upstream.origin,
      }).chat("scripted/model");

      const runTurn = async (
        messages: ModelMessage[],
        ask: boolean,
      ): Promise<{ executed: number; appliedInStream: boolean }> => {
        const seen: string[] = [];
        const result = streamText({
          model,
          messages,
          tools: {
            [REVISION_TOOL]: tool({
              inputSchema: rewriteInput,
              execute: (input, options) => {
                seen.push(JSON.stringify(options.messages.map((m) => m.role)));

                return { applied: true, summary: input.summary };
              },
            }),
          },
          toolApproval: {
            [REVISION_TOOL]: () =>
              ask
                ? ({ type: "user-approval", reason: "rewrite" } as const)
                : "not-applicable",
          },
        });

        const reader = toUIMessageStream({ stream: result.stream }).getReader();
        const types: string[] = [];

        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          types.push(value.type);
        }

        return {
          executed: seen.length,
          appliedInStream: types.includes("tool-output-available"),
        };
      };

      const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "Rewrite it." }],
      };

      const first = await runTurn([user], true);

      expect(first.executed, "the first request asks, and executes nothing").toBe(0);

      // The client's messages once the user has answered, as
      // `convertToModelMessages` sends them.
      const call = {
        type: "tool-call" as const,
        toolCallId: "call_rewrite",
        toolName: REVISION_TOOL,
        input: REWRITE,
      };
      const second = await runTurn(
        [
          user,
          { role: "assistant", content: [call] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-approval-request",
                approvalId: "approval_1",
                toolCallId: "call_rewrite",
              },
            ],
          },
          { role: "assistant", content: [call] },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "approval_1",
                approved: true,
                reason: "rewrite",
              },
            ],
          },
        ],
        false,
      );

      expect(second.executed, "the answered call runs, exactly once").toBe(1);
      expect(second.appliedInStream, "and its result reaches the client").toBe(true);
    } finally {
      upstream.close();
    }
  });
});

/** A whole-document rewrite: over existing text, it needs the user's answer. */
const REWRITE = {
  targetRegion: { wholeDocument: true },
  expectedText: "# The Bronze Age\n\nAround 1200 BCE, the trade networks fell.",
  replacementText: "# A different script\n\nWritten from the top.",
  isWholesaleDraft: false,
  summary: "Rewrote the whole script.",
};

const rewriteInput = z.object({
  targetRegion: z.object({ wholeDocument: z.literal(true) }),
  expectedText: z.string(),
  replacementText: z.string(),
  isWholesaleDraft: z.boolean().default(false),
  summary: z.string(),
});

const REWRITE_CALL =
  chunk({ role: "assistant" }, null) +
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: "call_rewrite",
          type: "function",
          function: { name: REVISION_TOOL, arguments: JSON.stringify(REWRITE) },
        },
      ],
    },
    null,
  ) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";
