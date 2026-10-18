/**
 * The PostgreSQL script repository.
 *
 * A Script and its Conversation are created in one transaction: a script with
 * no conversation must never be observable (FR-001). `updateContent` writes the
 * prior content as a revision in the same transaction as the new content
 * (FR-020). Deleting is a single statement whose cascade removes everything the
 * script owns (FR-001d). Renaming re-uses the creation-time title rules, so the
 * two cannot drift (FR-001c). `assignStyle` replaces the single style
 * association in one column, so a script can never hold two (FR-009), and a
 * style id outside the catalogue is refused rather than stored (FR-008).
 */

import { checkTitle } from "@/lib/domain/title";
import type {
  IsoTimestamp,
  RevisionOrigin,
  Script,
  ScriptId,
  ScriptSummary,
  StyleId,
} from "@/lib/domain/types";
import {
  RepositoryError,
  type ContentWriteResult,
  type CreatedScript,
  type NewScript,
  type ScriptMutationRepository,
  type ScriptRepository,
} from "@/lib/repositories/types";

import { getPool } from "./pool";
import { writeContentInTransaction } from "./revision-write";
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

export class PostgresScriptRepository
  implements
    ScriptRepository,
    Pick<ScriptMutationRepository, "delete" | "rename" | "assignStyle">
{
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

      // The timestamp is narrowed to the millisecond the application reports
      // (`toIso`) *before* it is built into the response, so no client ever
      // holds a timestamp it cannot echo back exactly. Every later write
      // stamps `updated_at` at the same precision (revision-write.ts), so the
      // `baseUpdatedAt` precondition compares like with like. `created_at` is
      // immutable and not handed to anyone yet, so the narrowing loses nothing.
      row.created_at = toIso(row.created_at);

      return {
        script: toScript(row),
        conversation: {
          id: conversationRow.id,
          scriptId: row.id,
          // The same millisecond `row.created_at` now holds: both rows were
          // inserted in one transaction, and which of the two a caller reads
          // as the script's timestamp must not depend on that.
          createdAt: toIso(row.created_at),
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

  async updateContent(
    id: ScriptId,
    content: string,
    baseUpdatedAt: IsoTimestamp,
    origin: RevisionOrigin,
  ): Promise<ContentWriteResult> {
    const client = await getPool().connect();

    try {
      await client.query("BEGIN");

      const written = await writeContentInTransaction(
        client,
        id,
        content,
        origin,
        baseUpdatedAt,
      );

      await client.query("COMMIT");

      return written;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original failure is the one worth reporting.
      });

      // A malformed id never finds its row, and the caller's contract maps it
      // onto the same not-found response (see `get`).
      if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Renames a script under the rules creation uses (FR-001c, FR-001b).
   *
   * The title is checked in application code before the statement so a blank
   * or over-long title is reported as `title_required` rather than as the
   * unique violation the database would raise for the all-blank-normalized
   * case; the unique index remains the authority on duplicates, so a race
   * cannot produce two identically titled scripts.
   */
  async rename(id: ScriptId, title: string): Promise<ScriptSummary> {
    const check = checkTitle(title);

    if (!check.valid) {
      throw new RepositoryError(
        "title_required",
        check.rule === "blank"
          ? "A script title is required"
          : "A script title must be at most 200 characters",
      );
    }

    let row: ScriptRow | undefined;

    try {
      const result = await getPool().query<ScriptRow>(
        `UPDATE scripts SET title = $2 WHERE id = $1
         RETURNING ${SCRIPT_COLUMNS}`,
        [id, check.title],
      );

      row = result.rows[0];
    } catch (error) {
      const code = pgErrorCode(error);

      if (code === UNIQUE_VIOLATION) {
        throw new RepositoryError(
          "title_taken",
          `A script titled "${check.title}" already exists`,
        );
      }

      if (code === INVALID_TEXT_REPRESENTATION) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      throw error;
    }

    // A rename that only changes case of the script's own title still matches
    // its own row and returns it; a missing row is an unknown script.
    if (!row) {
      throw new RepositoryError("not_found", `No script exists with id "${id}"`);
    }

    return toSummary(row);
  }

  /**
   * Deletes the script and everything that cascades from it (FR-001d).
   *
   * One statement is its own transaction: PostgreSQL removes the script, its
   * conversation, that conversation's messages, and its versions together, or
   * none of them. A separate `BEGIN`/`COMMIT` would add nothing to that.
   */
  async delete(id: ScriptId): Promise<void> {
    let rowCount: number | null;

    try {
      const result = await getPool().query("DELETE FROM scripts WHERE id = $1", [id]);

      rowCount = result.rowCount;
    } catch (error) {
      // A malformed id cannot name a script; the contract maps it onto the same
      // not-found response as an unknown one.
      if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      throw error;
    }

    if (rowCount !== 1) {
      throw new RepositoryError("not_found", `No script exists with id "${id}"`);
    }
  }

  /**
   * Assigns or replaces the script's single style (FR-009).
   *
   * A `UPDATE ... SET style_id` is a replacement by construction: there is one
   * column, so a second association cannot exist. The catalogue is checked
   * first so an unknown id is reported as `unknown_style`, as creation does,
   * rather than as the foreign-key violation it would surface as later.
   * `updated_at` is deliberately left alone: reordering the library by
   * "last modified" (FR-002) is about the document and its title, not the
   * register it is written in.
   */
  async assignStyle(
    id: ScriptId,
    styleId: StyleId,
  ): Promise<{ readonly styleId: StyleId }> {
    const client = await getPool().connect();

    try {
      await client.query("BEGIN");

      const style = await client.query("SELECT id FROM styles WHERE id = $1", [styleId]);

      if (style.rowCount !== 1) {
        throw new RepositoryError(
          "unknown_style",
          `No style exists with id "${styleId}"`,
        );
      }

      const updated = await client.query(
        "UPDATE scripts SET style_id = $2 WHERE id = $1 RETURNING id",
        [id, styleId],
      );

      if (updated.rowCount !== 1) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      await client.query("COMMIT");

      return { styleId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original failure is the one worth reporting.
      });

      if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) {
        throw new RepositoryError("not_found", `No script exists with id "${id}"`);
      }

      throw error;
    } finally {
      client.release();
    }
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
