/**
 * Turning a reopened script's stored turns into chat messages (T065, FR-003).
 *
 * Stored messages are plain `{ role, content }` rows; the chat panel renders
 * `UIMessage`s, whose text lives in parts. Kept apart from the hook so the
 * mapping — including what it refuses — is testable without a renderer.
 *
 * Note what a restored turn does *not* carry: the assistant's tool call. The
 * database records the summary of a change, never the revision, so a reopened
 * turn reads as a line of history rather than something the editor re-applies.
 */

import type { UIMessage } from "ai";

/** The fields this module reads from a stored message. */
export interface StoredTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * One UI message per stored turn, in the order given.
 *
 * A turn whose text is blank is still kept: dropping it would renumber the
 * history and hide that something happened, and an empty assistant turn is
 * possible when a change was recorded without a summary.
 */
export function restoredMessages(turns: readonly StoredTurn[]): UIMessage[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    parts: [{ type: "text", text: turn.content }],
  }));
}
