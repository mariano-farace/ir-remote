/**
 * `POST /api/chat` — the streaming assistant turn (FR-012, FR-014, FR-016).
 *
 * The route's job is to make the client's view irrelevant. It loads the script
 * and its style *server-side*, builds the system prompt from them on every
 * request, and hands the model one server-executed tool whose validator sees
 * that same document. A client that sends stale text changes nothing (FR-014);
 * a client cannot send a system prompt at all (FR-011).
 *
 * The client applies the returned revision through the single write path in
 * `src/stores/document-store.ts`. The route never writes document content: it
 * persists the user's message, and the assistant's summary once its change was
 * validated. Because the stream is aborted when the client stops generation,
 * a stopped request never reaches persistence (FR-014b).
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";

import { createScriptModel } from "@/lib/ai/provider";
import { buildChatRequest } from "@/lib/ai/prompt";
import {
  APPLY_DOCUMENT_REVISION_TOOL_NAME,
  createApplyDocumentRevisionTool,
  documentRevisionApproval,
  type DocumentRevisionResult,
} from "@/lib/ai/tools";
import { loadEnv } from "@/env";
import { promptFromChatBody } from "@/lib/http/chat-body";
import { errorResponse, readJsonBody, stringField } from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError, type Repositories } from "@/lib/repositories/types";

/**
 * An AI request must end, successfully or in a reported error, within 60 s
 * (FR-023). The bound is set to cover a full first draft, which a real model
 * takes 20–45 s to write; 30 s cut slow-but-successful drafts off mid-stream
 * and reported them as failures (SC-006).
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * What the user is told when the time bound is what ended the request.
 *
 * The SDK reports a timed-out stream as an `abort` chunk, which on the client
 * is indistinguishable from the user's own stop (FR-014b). A failed turn is
 * reported as an error instead, so the chat panel can say what happened
 * (FR-022a) rather than leave the user looking at a turn that quietly ended.
 */
const TIMEOUT_MESSAGE =
  "The assistant did not answer within 60 seconds. Your script was not changed.";

/** What the chat endpoint needs beyond the ids: the stream and its persistence. */
export interface AssistantDependencies {
  readonly streamText: typeof streamText;
  readonly convertToModelMessages: typeof convertToModelMessages;
  readonly createUIMessageStreamResponse: typeof createUIMessageStreamResponse;
  readonly toUIMessageStream: typeof toUIMessageStream;
}

const SDK: AssistantDependencies = {
  streamText,
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
};

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const scriptId = stringField(body, "scriptId");
  const conversationId = stringField(body, "conversationId");
  // `DefaultChatTransport` posts `messages`; the contract's minimal body posts
  // `message`. Only the newest user text is used from either (FR-014).
  const message = promptFromChatBody(body);

  if (scriptId === undefined || conversationId === undefined || message === undefined) {
    return errorResponse(
      "invalid_request",
      "`scriptId`, `conversationId`, and `message` are all required.",
    );
  }

  const repositories = getRepositories();

  let script;

  try {
    script = await repositories.scripts.get(scriptId);
    const conversation = await repositories.conversations.getByScriptId(scriptId);

    if (conversation.id !== conversationId) {
      return errorResponse(
        "conversation_mismatch",
        "Each script has its own conversation; refresh the chat and try again.",
      );
    }
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      return errorResponse("not_found", "That script no longer exists.");
    }

    console.error("POST /api/chat could not load the script", error);

    return errorResponse("invalid_request", "The script could not be loaded.");
  }

  let env;

  try {
    env = loadEnv();
  } catch (error) {
    // A missing key is a startup failure (Security); a request that reaches
    // here in development still gets an honest, non-secret-bearing message.
    console.error("POST /api/chat is missing configuration", error);

    return errorResponse("invalid_request", "The AI service is not configured.");
  }

  const history = await historyFor(repositories, conversationId, message);
  const style = await styleForScript(script.styleId);
  const prompt = buildChatRequest({ style, document: script.content, history });
  const tool = createApplyDocumentRevisionTool({ document: script.content });

  // The request's own time bound. Held here rather than left to `streamText`,
  // so the stream below can tell "the bound ended this" apart from anything
  // else that might abort it.
  const timeout = new AbortController();
  const deadline = setTimeout(
    () =>
      timeout.abort(new DOMException("The assistant request timed out.", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );

  /**
   * The text the UI stream reports for a turn it could not finish. A turn that
   * ran out of time says so (FR-022a); anything else gets the SDK's default,
   * which names the failure without echoing the upstream error.
   */
  function onError(error: unknown): string {
    if (isTimeout(error)) {
      return TIMEOUT_MESSAGE;
    }

    // A failure reported after the deadline belongs to the deadline. Until
    // this check existed, a timed-out turn reached the client as an `abort`
    // (the SDK's report of the request it aborted), which the chat cannot tell
    // apart from the user's own stop — so it ended in silence.
    if (timeout.signal.aborted) {
      return TIMEOUT_MESSAGE;
    }

    // A refused tool call is reported here rather than in `streamText`'s own
    // `onError`, with its cause kept server-side.
    console.error("POST /api/chat: a tool call failed", describeUpstreamError(error));

    return "An error occurred.";
  }

  const result = SDK.streamText({
    model: createScriptModel(env),
    system: prompt.system,
    // The prior turns are history the user can see, ending with the message
    // that was just persisted.
    messages: await SDK.convertToModelMessages(toUiMessages(history)),
    tools: { [APPLY_DOCUMENT_REVISION_TOOL_NAME]: tool },
    // A call that would clear the script is put to the user before it executes
    // (FR-021). The client answers through `addToolApprovalResponse`; the
    // model's own claims about consent are never consulted.
    toolApproval: {
      [APPLY_DOCUMENT_REVISION_TOOL_NAME]: documentRevisionApproval(script.content),
    },
    abortSignal: timeout.signal,
    onError: ({ error }) => {
      // The client sees the SDK's generic "An error occurred."; the cause (a
      // tool call the schema refused, an upstream HTTP error) exists only here.
      // Details and validation messages only — never prompt contents or keys.
      console.error(
        "POST /api/chat: the assistant turn failed",
        describeUpstreamError(error),
      );
    },
    onFinish: async ({ steps }) => {
      // The timer is released however the turn ends, so a finished turn cannot
      // later abort a request that is no longer running.
      clearTimeout(deadline);

      const summary = steps
        .flatMap((step) => step.toolResults)
        .filter((toolResult) => toolResult.toolName === APPLY_DOCUMENT_REVISION_TOOL_NAME)
        .map((toolResult) => toolResult.output as DocumentRevisionResult)
        .find((output) => output.applied)?.summary;

      if (summary) {
        await repositories.conversations
          .append(conversationId, "assistant", summary)
          .catch((error: unknown) => {
            console.error("POST /api/chat could not persist the summary", error);
          });
      }
    },
  });

  // The answer streams into a UI-message stream the SDK owns, so the request's
  // deadline can be reported as a failure the client sees (FR-022a). Aborting
  // `streamText` alone only produces an `abort` chunk, which the client cannot
  // tell apart from the user's own stop (FR-014b).
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The answer's turn is over when its stream ends, whether it succeeded,
      // failed, or the user stopped it — in every one of those cases the
      // deadline must not add a second outcome. From this promise onward, a
      // deadline that passes is a deadline that ended the turn.
      let answerEnded = () => {};
      const ended = new Promise<"ended">((resolve) => {
        answerEnded = () => resolve("ended");
      });
      const outOfTime = new Promise<"timeout">((resolve) => {
        const note = () => resolve("timeout");

        if (timeout.signal.aborted) {
          note();
        } else {
          timeout.signal.addEventListener("abort", note, { once: true });
        }
      });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          onError,
          // `toUIMessageStream` does nothing with `onEnd`; it is handed the
          // end of the answer stream all the same, because the promise it
          // resolves is what lets `execute` above end with the answer rather
          // than run until the deadline.
          onEnd: answerEnded,
        }),
      );

      if ((await Promise.race([ended, outOfTime])) === "ended") {
        return;
      }

      // The turn is over either way once the deadline passes: nothing it would
      // still produce could be applied, so the answer is not waited on. The
      // failure is reported through the merge's `onError`, the same one that
      // names a failed answer.
      throw timedOutError(timeout.signal.reason);
    },
    onError,
  });

  return createUIMessageStreamResponse({ stream });
}

/**
 * The failure a timed-out request ends in.
 *
 * The message travels as the cause's message (the bound, plainly): the UI
 * stream reports a merged writer's failure through its cause, and that is
 * what the user is told.
 */
function timedOutError(reason: unknown): Error {
  return new Error(TIMEOUT_MESSAGE, {
    cause: new Error(TIMEOUT_MESSAGE, { cause: reason }),
  });
}

/**
 * The user's message persisted, plus the turns before it.
 *
 * The new message is written first (the contract says "immediately"), so the
 * model receives it after the earlier turns, exactly as it arrived.
 */
async function historyFor(
  repositories: Repositories,
  conversationId: string,
  message: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const earlier = await repositories.conversations.getMessages(conversationId);

  await repositories.conversations.append(conversationId, "user", message);

  return [
    ...earlier.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: "user", content: message },
  ];
}

/**
 * The script's style, server-side. A script with no style still needs a
 * request-level prompt, so asked-for guidance falls back to the catalogue's
 * first entry rather than inventing tone (the UI prompts for a style itself).
 */
async function styleForScript(styleId: string | null) {
  const repositories = getRepositories();
  const style = styleId
    ? await repositories.styles.get(styleId)
    : (await repositories.styles.list())[0];

  if (!style) {
    throw new Error("The style catalogue is empty: db/seed/styles.sql was not applied");
  }

  return style;
}

/** Whether a failure is the request's own time bound, not the upstream's. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * A loggable summary of a failed turn.
 *
 * Zod and `AI_InvalidToolInputError` carry the validation detail in `cause`;
 * provider errors carry a status code. `input` is deliberately not included:
 * it is the model's draft of the user's script.
 */
function describeUpstreamError(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
    const detail =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : typeof cause === "object" && cause !== null && "message" in cause
            ? String((cause as { message: unknown }).message)
            : "";

    return [error.name, error.message, detail].filter(Boolean).join(": ").slice(0, 2_000);
  }

  return String(error).slice(0, 2_000);
}

/** Conversation turns as UI messages, so `convertToModelMessages` can read them. */
function toUiMessages(
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): UIMessage[] {
  return history.map((entry, index) => ({
    id: `history-${index}`,
    role: entry.role,
    parts: [{ type: "text", text: entry.content }],
  }));
}
