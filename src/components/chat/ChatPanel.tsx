"use client";

import type { UIMessage } from "ai";
import { useState } from "react";

import { ErrorBanner } from "@/components/chat/ErrorBanner";
import { describeToolPart } from "@/components/chat/tool-parts";
import { composerControl } from "@/lib/chat/chat-composer";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { useDocumentStore } from "@/stores/document-store";

/**
 * The length past which the model may lose context (FR-014c). The request is
 * still sent — the script is never truncated to fit — but the user is told
 * first, because the answer may quietly ignore part of what they wrote.
 */
const LONG_SCRIPT_LENGTH = 50_000;

/**
 * The conversation panel (T038).
 *
 * Sending is a request for a change, not a chat reply: the assistant answers
 * with at most a one-sentence summary, and the change itself is carried by the
 * tool call the editor applies (FR-016, SC-002). The panel never writes
 * document text.
 *
 * Opening a script restores its own stored turns before the panel accepts a
 * follow-up (FR-003): the conversation shown is always the active script's.
 * A history that could not be read is reported, not silently shown as empty.
 *
 * A script with no style is not sent to the model at all (spec.md Edge Cases):
 * the panel takes the prompt, says a style is needed, and sends nothing, so the
 * reply can never be a generic-tone script the user did not ask for. Choosing a
 * style anywhere in the workspace — the sidebar's selector shares the same
 * library — clears the prompt, and the user sends again.
 *
 * A script past the model's comfortable size is not sent until the user has
 * been told the AI may lose context (FR-014c); the prompt is kept and the
 * script is sent whole, never truncated.
 */
export function ChatPanel() {
  const workspace = useWorkspace();
  const conversation = workspace.conversation;
  const [input, setInput] = useState("");
  // Whether the current request stopped at the style gate.
  const [styleRequired, setStyleRequired] = useState(false);
  // A request held back by the long-script warning, until the user proceeds.
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const documentLength = useDocumentStore((state) => state.content.length);

  const bound = workspace.active !== null && workspace.activeConversationId !== null;
  const ready = bound && !workspace.restoringConversation;
  // While a response streams this is the stop control, and no send is possible
  // (FR-014a); the rules themselves are in `chat-composer`.
  const control = composerControl({
    streaming: conversation.streaming,
    hasText: input.trim() !== "",
    ready,
  });

  // The prompt is a fact about the present: once a style is associated, it no
  // longer applies, whoever chose it.
  if (styleRequired && workspace.activeStyleId !== null) {
    setStyleRequired(false);
  }

  function send(event: React.FormEvent) {
    event.preventDefault();
    const text = input;

    if (!ready || conversation.streaming || text.trim() === "") {
      return;
    }

    if (workspace.activeStyleId === null) {
      // The draft stays in the input: the user's next step is to choose a
      // style and send, not to retype the request.
      setStyleRequired(true);
      return;
    }

    setStyleRequired(false);

    // The script is not shortened to fit any model: the user is told the
    // context may be lost and decides, and the same prompt is sent whole.
    if (documentLength > LONG_SCRIPT_LENGTH) {
      setPendingSend(text);

      return;
    }

    setInput("");
    void conversation.send(text);
  }

  function sendAnyway(): void {
    const text = pendingSend;

    setPendingSend(null);

    if (text === null) {
      return;
    }

    setInput("");
    void conversation.send(text);
  }

  return (
    <section aria-label="Conversation" className="workspace-panel flex flex-col border-r">
      {bound && workspace.restoringConversation ? (
        <p role="status" className="text-foreground-muted flex-1 p-4 text-sm">
          Restoring this script&apos;s conversation…
        </p>
      ) : ready ? (
        <ol
          aria-label="Conversation"
          role="log"
          className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          {conversation.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ol>
      ) : (
        <p className="text-foreground-muted flex-1 p-4 text-sm">
          Create or open a script to start a conversation.
        </p>
      )}

      {pendingSend !== null ? (
        <div
          role="alert"
          aria-label="Long script"
          className="mx-4 mb-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs"
        >
          <p>
            This script is longer than 50 000 characters. The AI may lose some of that
            context when it responds — nothing will be removed from your script.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={sendAnyway}
              className="text-accent rounded px-2 py-1"
            >
              Send anyway
            </button>
            <button
              type="button"
              onClick={() => setPendingSend(null)}
              className="text-foreground-muted rounded px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {styleRequired && workspace.activeStyleId === null ? (
        <p
          role="alert"
          aria-label="Style required"
          className="px-4 py-2 text-xs text-red-700"
        >
          Choose a style before sending: the style shapes how the assistant writes.
        </p>
      ) : null}

      {workspace.conversationError ? (
        <p role="alert" className="px-4 pb-2 text-xs text-red-700">
          This script&apos;s conversation could not be restored.{" "}
          {workspace.conversationError.message}
        </p>
      ) : null}

      {conversation.producedNoChange ? (
        <p className="text-foreground-muted px-4 pb-2 text-xs">
          The assistant produced no change to the script.
        </p>
      ) : null}

      <ErrorBanner
        failure={
          conversation.error
            ? {
                cause: conversation.error.cause ?? "upstream",
                message: conversation.error.message,
              }
            : null
        }
      />

      <form onSubmit={send} className="flex flex-col gap-2 border-t p-4">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          aria-label="Message"
          rows={3}
          value={input}
          // Editable while streaming, but not sendable (FR-014a).
          onChange={(event) => setInput(event.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
        {control.kind === "stop" ? (
          <button
            type="button"
            onClick={conversation.stop}
            className="self-end rounded border px-3 py-1 text-sm"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={control.disabled}
            className="bg-accent self-end rounded px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </section>
  );
}

/**
 * One turn: its text and, for each revision it proposed, the summary or the
 * reason nothing changed — never the script body (SC-002).
 */
function Message({ message }: { readonly message: UIMessage }) {
  const descriptions = message.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => describeToolPart(part))
    .filter(
      (description): description is string => description !== null && description !== "",
    );

  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  return (
    <li
      role="article"
      aria-label={message.role === "user" ? "You" : "Assistant"}
      className="text-sm"
    >
      <p className="text-foreground-muted text-xs">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      {text ? <p className="whitespace-pre-wrap">{text}</p> : null}
      {descriptions.map((description) => (
        <p key={description} className="text-foreground-muted mt-1 text-xs">
          {description}
        </p>
      ))}
    </li>
  );
}
