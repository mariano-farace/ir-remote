/**
 * The PostgreSQL script repository.
 *
 * A Script and its Conversation are created in one transaction: a script with
 * no conversation must never be observable (FR-001). The remaining operations
 * arrive with the user stories that need them, each preceded by its own test —
 * `updateContent` with T049 (US2), `rename` with T067 and `delete` with T068
 * (US3), `assignStyle` with T074 (US4). Implementing them here ahead of those
 * tests would put untested behavior on the single write path the constitution
 * governs.
 */

import { checkTitle } from "@/lib/domain/title";
import type {
  IsoTimestamp,
  Script,
  ScriptId,
  ScriptSummary,
  StyleId,
} from "@/lib/domain/types";
import {
  RepositoryError,
  type CreatedScript,
  type NewScript,
  type ScriptRepository,
} from "@/lib/repositories/types";

import { getPool } from "./pool";
import { toIso } from "./rows";

interface ScriptRow {
  id: string;
  title: string;
  content: string;
  style_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SCRIPT_COLUMNS = "id, title, content, style_id, created_at, updated_at";

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** PostgreSQL's `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = "23503";

/** PostgreSQL's `invalid_text_representation`, raised when a string is not a valid UUID. */
const INVALID_TEXT_REPRESENTATION = "22P02";

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };

    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function toScript(row: ScriptRow): Script {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    styleId: row.style_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toSummary(row: ScriptRow): ScriptSummary {
  return {
    id: row.id,
    title: row.title,
    styleId: row.style_id,
    updatedAt: toIso(row.updated_at),
  };
}

export class PostgresScriptRepository implements ScriptRepository {
  async list(): Promise<readonly ScriptSummary[]> {
    const result = await getPool().query<ScriptRow>(
      `SELECT ${SCRIPT_COLUMNS} FROM scripts ORDER BY updated_at DESC, id DESC`,
    );

    return result.rows.map(toSummary);
  }

  /**
   * Creates a script and its conversation atomically.
   *
   * The title is validated here as well as at the route boundary: the database
   * constraint is the last line of defence, but reaching it with a blank title
   * would produce a `title_taken`-shaped error for what is really a blank title,
   * and FR-001b requires the two to be distinguishable.
   */
  async create(input: NewScript): Promise<CreatedScript> {
    const check = checkTitle(input.title);

    if (!check.valid) {
      throw new RepositoryError(
        "title_required",
        check.rule === "blank"
          ? "A script title is required"
          : `A script title must be at most 200 characters`,
      );
    }

    const client = await getPool().connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query<ScriptRow>(
        `INSERT INTO scripts (title, content, style_id)
         VALUES ($1, $2, $3)
         RETURNING ${SCRIPT_COLUMNS}`,
        [check.title, input.content ?? "", input.styleId],
      );

      const row = inserted.rows[0];

      if (!row) {
        throw new Error("Inserting a script returned no row");
      }

      const conversation = await client.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO conversations (script_id) VALUES ($1)
         RETURNING id, created_at`,
        [row.id],
      );

      const conversationRow = conversation.rows[0];

      if (!conversationRow) {
        throw new Error("Inserting a conversation returned no row");
      }

      await client.query("COMMIT");

      return {
        script: toScript(row),
        conversation: {
          id: conversationRow.id,
          scriptId: row.id,
          createdAt: toIso(conversationRow.created_at),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original failure is the one worth reporting; a rollback that
        // itself fails (because the connection died) must not mask it.
      });

      throw translateCreateError(error, check.title, input.styleId);
    } finally {
      client.release();
    }
  }

  async get(id: ScriptId): Promise<Script> {
    let row: ScriptRow | undefined;

    try {
      const result = await getPool().query<ScriptRow>(
        `SELECT ${SCRIPT_COLUMNS} FROM scripts WHERE id = $1`,
        [id],
      );

      row = result.rows[0];
    } catch (error) {
      // An id that is not a UUID is a malformed lookup, not a server fault, and
      // the caller's contract maps it onto the same not-found response.
      if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      throw error;
    }

    if (!row) {
      throw new RepositoryError("not_found", `No script exists with id "${id}"`);
    }

    return toScript(row);
  }
}

/**
 * Maps a driver error onto the repository's vocabulary.
 *
 * A normalized-title collision is the only unique constraint `create` can hit:
 * `scripts` has one, and `conversations` is keyed by a freshly generated script
 * id. A bad style reference is a foreign-key violation.
 */
function translateCreateError(
  error: unknown,
  title: string,
  styleId: StyleId | null,
): unknown {
  const code = pgErrorCode(error);

  if (code === UNIQUE_VIOLATION) {
    return new RepositoryError(
      "title_taken",
      `A script titled "${title}" already exists`,
    );
  }

  if (code === FOREIGN_KEY_VIOLATION && styleId !== null) {
    return new RepositoryError("unknown_style", `No style exists with id "${styleId}"`);
  }

  return error;
}

export type { IsoTimestamp };
