/**
 * Reading the prompt out of a chat request body.
 *
 * Two shapes arrive. The contract's minimal body carries a `message` string;
 * the AI SDK's `DefaultChatTransport` — what the workspace's chat panel sends —
 * carries the whole conversation as `messages` with typed parts. Both are
 * accepted, and in both the only thing the server takes is the latest user
 * text: everything else (the document, the style, history) is loaded
 * server-side, so a client cannot poison the model's view of the script
 * (FR-014, contracts/http-api.md cross-cutting rules).
 */

import { stringField } from "@/lib/http/envelope";

/** The newest user text in a `messages` array, or `undefined` if there is none. */
function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const lastUser = [...messages]
    .reverse()
    .find(
      (message): message is { role: string; parts?: unknown; content?: unknown } =>
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "user",
    );

  if (!lastUser) {
    return undefined;
  }

  // A message in the older `{ role, content }` shape has no typed parts.
  if (typeof lastUser.content === "string") {
    return lastUser.content.trim() !== "" ? lastUser.content : undefined;
  }

  const fromParts = Array.isArray(lastUser.parts)
    ? lastUser.parts
        .filter(
          (part): part is { type: string; text: string } =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("")
    : "";

  return fromParts.trim() !== "" ? fromParts : undefined;
}

/** The prompt of a chat request, whichever of the two body shapes it used. */
export function promptFromChatBody(body: unknown): string | undefined {
  return stringField(body, "message") ?? lastUserText(unsafeField(body, "messages"));
}

function unsafeField(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null && key in body
    ? (body as Record<string, unknown>)[key]
    : undefined;
}
