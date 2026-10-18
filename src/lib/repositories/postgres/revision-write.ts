/**
 * The one revision-first content write (FR-020, constitution Recoverability).
 *
 * Every path that changes a script's content goes through `writeContentInTransaction`:
 * autosave (`updateContent`) and undo (`restore`). It records the content being
 * replaced as a ScriptVersion, then applies the new content and its `updatedAt`,
 * both inside the caller's transaction. If the version insert fails, the
 * content update never commits, so a write is never persisted without the
 * history that makes it undoable.
 *
 * Kept apart from the repositories that call it so the ordering lives in one
 * place; a second copy of this sequence would be the second write path the
 * constitution forbids.
 */

import type { PoolClient } from "pg";

import type { IsoTimestamp, RevisionOrigin, ScriptId } from "@/lib/domain/types";
import { RepositoryError } from "@/lib/repositories/types";

import { toIso } from "./rows";

interface ScriptLockRow {
  content: string;
  updated_at: Date | string;
  /** True when `baseUpdatedAt` still names this row's current value, judged by PostgreSQL. */
  base_is_current: boolean | null;
}

interface UpdatedRow {
  updated_at: Date | string;
}

/**
 * Records the current content, then applies `content`.
 *
 * The script row is locked first, so its `updated_at` doubles as a per-script
 * clock: every write ticks it forward past both the previous value and
 * `now()`. That keeps two writes distinct even when they share a transaction
 * timestamp (`now()` is fixed for a transaction), so version ordering never
 * depends on the random UUID tiebreak.
 *
 * @param client A client with an open transaction. This function does not
 *   begin or commit; the caller decides what else belongs in the transaction.
 * @param baseUpdatedAt When given, the write is refused if the stored
 *   `updatedAt` has moved past it (FR-019).
 * @throws {RepositoryError} `not_found` for an unknown script, `stale_write`
 *   when `baseUpdatedAt` is behind the stored value, `invalid_request` when it
 *   is not an ISO timestamp.
 */
export async function writeContentInTransaction(
  client: PoolClient,
  scriptId: ScriptId,
  content: string,
  origin: RevisionOrigin,
  baseUpdatedAt?: IsoTimestamp,
): Promise<{ readonly updatedAt: IsoTimestamp }> {
  // Parsed before it reaches SQL: an unparseable value must be a rejection the
  // client can act on, not a driver error shaped like something else.
  if (baseUpdatedAt !== undefined && Number.isNaN(Date.parse(baseUpdatedAt))) {
    throw new RepositoryError(
      "invalid_request",
      "`baseUpdatedAt` must be an ISO 8601 timestamp",
    );
  }

  // The staleness check runs inside the locked read, in the database's own
  // comparison. A save's `updatedAt` is in whole milliseconds, while a column
  // that has not been rewritten since the script was created still carries
  // sub-millisecond digits; the base is accepted when it equals the stored
  // value exactly or falls within the millisecond the stored value occupies.
  // Anything older is a write based on a version that has since moved on.
  const locked = await client.query<ScriptLockRow>(
    `SELECT content, updated_at,
            $2::timestamptz IS NOT NULL AND (
              $2::timestamptz = updated_at
              OR ($2::timestamptz < updated_at
                  AND $2::timestamptz >= updated_at - interval '1 millisecond')
            ) AS base_is_current
       FROM scripts
      WHERE id = $1
        FOR UPDATE`,
    [scriptId, baseUpdatedAt ?? null],
  );

  const current = locked.rows[0];

  if (!current) {
    throw new RepositoryError("not_found", `No script exists with id "${scriptId}"`);
  }

  if (baseUpdatedAt !== undefined && current.base_is_current !== true) {
    throw new RepositoryError(
      "stale_write",
      "The script changed since it was loaded; reload it before saving again",
    );
  }

  const updatedAt = nextUpdatedAt(toIso(current.updated_at));

  // The version records the content this write replaces, and shares the
  // script's new `updatedAt`, so history and document move as one clock.
  await client.query(
    `INSERT INTO script_versions (script_id, content, origin, created_at)
     VALUES ($1, $2, $3, $4::timestamptz)`,
    [scriptId, current.content, origin, updatedAt],
  );

  const updated = await client.query<UpdatedRow>(
    `UPDATE scripts
        SET content = $2, updated_at = $3::timestamptz
      WHERE id = $1
      RETURNING updated_at`,
    [scriptId, content, updatedAt],
  );

  if (!updated.rows[0]) {
    throw new Error("Updating script content returned no row");
  }

  return { updatedAt };
}

/**
 * The next tick for a script's clock: at least one millisecond later than the
 * stored value (as the app reads it) and never behind `now()`.
 *
 * Millisecond resolution is the format every `updatedAt` in the application
 * uses (`toIso`). `create` stores its `createdAt` truncated to the same
 * precision, so the value a client echoes back after creation equals the
 * stored one exactly.
 */
function nextUpdatedAt(stored: IsoTimestamp): IsoTimestamp {
  return new Date(Math.max(Date.parse(stored) + 1, Date.now())).toISOString();
}
