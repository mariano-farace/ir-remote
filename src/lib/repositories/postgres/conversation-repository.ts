/**
 * The PostgreSQL conversation repository.
 *
 * A conversation belongs to exactly one script (the schema's unique constraint
 * enforces it), so every query here is scoped by conversation id and can never
 * return another script's messages (FR-006). Ordering is `created_at` then
 * `seq`, the same tiebreak the index uses, so messages written in the same
 * millisecond keep their insertion order.
 */

import type {
  Conversation,
  ConversationId,
  Message,
  MessageRole,
  ScriptId,
} from "@/lib/domain/types";
import { RepositoryError, type ConversationRepository } from "@/lib/repositories/types";

import { getPool } from "./pool";
import { toIso, toRole } from "./rows";

interface ConversationRow {
  id: string;
  script_id: string;
  created_at: Date | string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: Date | string;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    scriptId: row.script_id,
    createdAt: toIso(row.created_at),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: toRole(row.role),
    content: row.content,
    createdAt: toIso(row.created_at),
  };
}

export class PostgresConversationRepository implements ConversationRepository {
  async append(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<Message> {
    // The foreign key rejects an unknown conversation; a non-UUID id never
    // reaches it. Both are translated to the repository vocabulary so callers
    // never see a pg code.
    try {
      const result = await getPool().query<MessageRow>(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, $2, $3)
         RETURNING id, conversation_id, role, content, created_at`,
        [conversationId, role, content],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error("Appending a message returned no row");
      }

      return toMessage(row);
    } catch (error) {
      if (isForeignKeyViolation(error) || isInvalidUuid(error)) {
        throw new RepositoryError(
          "not_found",
          `No conversation exists with id "${conversationId}"`,
        );
      }

      throw error;
    }
  }

  async getMessages(conversationId: ConversationId): Promise<readonly Message[]> {
    await this.get(conversationId);

    const result = await getPool().query<MessageRow>(
      `SELECT id, conversation_id, role, content, created_at
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at, seq`,
      [conversationId],
    );

    return result.rows.map(toMessage);
  }

  async getByScriptId(scriptId: ScriptId): Promise<Conversation> {
    return this.get(scriptId, "script");
  }

  /** One conversation by id, or by owning script. */
  private async get(
    id: ConversationId | ScriptId,
    by: "id" | "script" = "id",
  ): Promise<Conversation> {
    const column = by === "id" ? "id" : "script_id";
    let row: ConversationRow | undefined;

    try {
      const result = await getPool().query<ConversationRow>(
        `SELECT id, script_id, created_at FROM conversations WHERE ${column} = $1`,
        [id],
      );

      row = result.rows[0];
    } catch (error) {
      if (isInvalidUuid(error)) {
        throw new RepositoryError("not_found", "No conversation exists with that id");
      }

      throw error;
    }

    if (!row) {
      throw new RepositoryError(
        "not_found",
        `No conversation exists with that ${column}`,
      );
    }

    return toConversation(row);
  }
}

/** PostgreSQL's `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = "23503";

/** PostgreSQL's `invalid_text_representation`, raised for a non-UUID id. */
const INVALID_TEXT_REPRESENTATION = "22P02";

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };

    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === FOREIGN_KEY_VIOLATION;
}

function isInvalidUuid(error: unknown): boolean {
  return pgErrorCode(error) === INVALID_TEXT_REPRESENTATION;
}
