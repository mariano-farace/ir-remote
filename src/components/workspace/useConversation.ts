"use client";

/**
 * The active script's conversation, shared by the chat panel and the editor.
 *
 * Both panels need it: the chat renders the turns, and the editor applies the
 * revisions those turns carry. Holding it above both is also what keeps one
 * request in flight per script (FR-014a).
 */

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useMemo, useState } from "react";

import type { FailureCause } from "@/components/chat/ErrorBanner";
import type { ToolApprovalResponse } from "@/components/chat/tool-parts";
import { envelopeFetch, type ApiError } from "@/lib/http/client";

/** The stored conversation a script was opened with. */
export interface ConversationSeed {
  /** The conversation the turns belong to; nothing else is trusted. */
  readonly conversationId: string;
  readonly messages: UIMessage[];
}

/**
 * Which failure the user is looking at (FR-022a).
 *
 * The causes are told apart by the code when the failure carries one — the
 * chat route's timeout code, a revision the server refused to validate, the
 * save conflict — and by the error's own shape otherwise. Wording is only a
 * last resort because it is the least reliable signal: "did not answer within
 * 60 seconds" reads as an outage to any text match that misses it.
 */
export function failureOf(error: unknown): ApiError & { readonly cause: FailureCause } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;

  // The chat SDK hands the browser a plain `Error` carrying only the stream's
  // error text, so the route's own sentence is matched as well as the code.
  const timedOut =
    code === "assistant_timeout" ||
    status === 504 ||
    /timed?\s?out|timeout|did not answer within/i.test(message);

  if (timedOut) {
    return {
      code: "assistant_timeout",
      cause: "timeout",
      message: "The assistant took too long to answer. Your script was not changed.",
    };
  }

  if (code === "invalid_output") {
    return {
      code: "invalid_output",
      cause: "invalid_output",
      message:
        "The assistant produced a change that could not be used. Your script was not changed.",
    };
  }

  if (code === "stale_write") {
    return {
      code: "stale_write",
      cause: "conflict",
      message:
        "The script changed while this was being applied. Your text was left as it is.",
    };
  }

  return {
    code: "assistant_upstream_failure",
    cause: "upstream",
    message: "The assistant could not answer. Your script was not changed.",
  };
}

export interface Conversation {
  readonly messages: UIMessage[];
  /** `true` from send until the response ends or is stopped. */
  readonly streaming: boolean;
  /** A failed turn, classified so the banner can tell a timeout from an outage. */
  readonly error: (ApiError & { readonly cause: FailureCause }) | null;
  /** The current turn ended without applying anything, so the user is told. */
  readonly producedNoChange: boolean;
  /** Starts a turn. Refused while one is streaming or with no active script. */
  send(text: string): Promise<void>;
  /** Ends the current response immediately; no partial revision is persisted (FR-014b). */
  stop(): void;
  /**
   * Sends the user's answer to a tool call the server held for approval
   * (FR-021). `useChat`'s `addToolApprovalResponse`; the editor's
   * clear-confirmation is what calls it.
   */
  answerApproval(response: ToolApprovalResponse): void;
}

function isRevisionToolPart(part: UIMessage["parts"][number]): boolean {
  return part.type.startsWith("tool-");
}

/** A settled assistant turn that proposed no applied revision. */
function turnProducedNoChange(messages: readonly UIMessage[]): boolean {
  const last = messages.at(-1);

  if (!last || last.role !== "assistant") {
    return false;
  }

  return !last.parts.some(
    (part) =>
      isRevisionToolPart(part) &&
      (part as { state?: string; output?: { applied?: boolean } }).state ===
        "output-available" &&
      (part as { output?: { applied?: boolean } }).output?.applied === true,
  );
}

/**
 * A conversation bound to one script. The request carries only ids and the
 * prompt: the document and style are loaded server-side (FR-014).
 *
 * The chat is keyed by conversation id. Opening another script builds a new
 * chat, so the previous script's turns — and any stream still running for it —
 * leave the panel in the same update that binds the new script, rather than
 * after an effect or an effect-time read (FR-003, FR-006, SC-008). The history
 * itself arrives as `seed`, loaded by the same `open` call that loaded the
 * document, so the two panels change together.
 */
export function useConversation({
  scriptId,
  conversationId,
  seed,
}: {
  readonly scriptId: string | null;
  readonly conversationId: string | null;
  /** The opened script's stored turns; used when it names this conversation. */
  readonly seed: ConversationSeed | null;
}): Conversation {
  const [finished, setFinished] = useState(0);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { scriptId, conversationId },
        fetch: envelopeFetch,
      }),
    [scriptId, conversationId],
  );

  const chat = useChat({
    id: conversationId ?? undefined,
    transport,
    // Read once, when the chat for this conversation is created. Anything that
    // arrives later is pushed through `setMessages` below.
    messages: seed?.conversationId === conversationId ? [...seed.messages] : [],
    onFinish: () => setFinished((count) => count + 1),
  });

  // A seed that arrived after the chat existed (opening the active script
  // again, which reloads it from the server). A chat that already holds a turn
  // belongs to someone who is mid-conversation, so it is left alone.
  const seeded = seed !== null && seed.conversationId === conversationId;
  const chatIsIdle = chat.status !== "submitted" && chat.status !== "streaming";

  if (seeded && chatIsIdle && chat.messages.length === 0 && seed.messages.length > 0) {
    chat.setMessages([...seed.messages]);
  }

  const streaming = chat.status === "submitted" || chat.status === "streaming";
  // A turn that ended in a reported error is already told its own cause
  // (FR-022a). Saying it "produced no change" as well would name the wrong
  // one — the model did produce a change, the request just failed or ran out
  // of time — so the no-change note is held back when there is an error.
  const producedNoChange =
    finished > 0 && !streaming && chat.error == null && turnProducedNoChange(chat.messages);

  async function send(text: string): Promise<void> {
    const message = text.trim();

    if (message === "" || streaming || scriptId === null || conversationId === null) {
      return;
    }

    setFinished(0);
    await chat.sendMessage({ text: message }, { body: { scriptId, conversationId } });
  }

  return {
    messages: chat.messages,
    streaming,
    error: chat.error ? failureOf(chat.error) : null,
    producedNoChange,
    send,
    stop: chat.stop,
    answerApproval: (response) => {
      void chat.addToolApprovalResponse(response);
    },
  };
}
