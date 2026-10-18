/**
 * The PostgreSQL revision repository (FR-020).
 *
 * A version is a snapshot of a script's content as it was *before* a change.
 * Listing returns previews rather than full documents because the undo list
 * shows the first line, not the script; restoring replays a version through the
 * same revision-first write as autosave, so an undo is itself undoable.
 */

import type {
  ScriptId,
  ScriptVersion,
  ScriptVersionId,
  ScriptVersionPreview,
} from "@/lib/domain/types";
import {
  RepositoryError,
  type RestoreResult,
  type RevisionRepository,
} from "@/lib/repositories/types";

import { getPool } from "./pool";
import { writeContentInTransaction } from "./revision-write";
import { toIso, toRevisionOrigin } from "./rows";

/** The first characters of a version shown in the undo list. */
export const PREVIEW_LENGTH = 200;

interface VersionRow {
  id: string;
  script_id: string;
  content: string;
  origin: string;
  created_at: Date | string;
}

/** `invalid_text_representation`, raised when a string is not a valid UUID. */
const INVALID_TEXT_REPRESENTATION = "22P02";

function isInvalidUuid(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === INVALID_TEXT_REPRESENTATION
  );
}

function toVersion(row: VersionRow): ScriptVersion {
  return {
    id: row.id,
    scriptId: row.script_id,
    content: row.content,
    origin: toRevisionOrigin(row.origin),
    createdAt: toIso(row.created_at),
  };
}

export class PostgresRevisionRepository implements RevisionRepository {
  async list(scriptId: ScriptId): Promise<readonly ScriptVersionPreview[]> {
    // A script with no versions lists an empty history; an unknown script is
    // a missing resource. Checking existence here keeps the two apart.
    let scriptExists: boolean;

    try {
      const result = await getPool().query("SELECT 1 FROM scripts WHERE id = $1", [
        scriptId,
      ]);

      scriptExists = (result.rowCount ?? 0) > 0;
    } catch (error) {
      if (isInvalidUuid(error)) {
        throw new RepositoryError("not_found", `No script exists with id "${scriptId}"`);
      }

      throw error;
    }

    if (!scriptExists) {
      throw new RepositoryError("not_found", `No script exists with id "${scriptId}"`);
    }

    // Ordered oldest first so the chronological index is simply the position;
    // the list itself is returned newest first, as the undo affordance needs.
    let rows: VersionRow[];

    try {
      const result = await getPool().query<VersionRow>(
        `SELECT id, script_id, content, origin, created_at
           FROM script_versions
          WHERE script_id = $1
          ORDER BY created_at, id`,
        [scriptId],
      );

      rows = result.rows;
    } catch (error) {
      if (isInvalidUuid(error)) {
        throw new RepositoryError("not_found", `No script exists with id "${scriptId}"`);
      }

      throw error;
    }

    return rows
      .map((row, position) => ({
        id: row.id,
        index: position + 1,
        createdAt: toIso(row.created_at),
        origin: toRevisionOrigin(row.origin),
        preview: [...row.content].slice(0, PREVIEW_LENGTH).join(""),
      }))
      .reverse();
  }

  async restore(scriptId: ScriptId, versionId: ScriptVersionId): Promise<RestoreResult> {
    const client = await getPool().connect();

    try {
      await client.query("BEGIN");

      let version: VersionRow | undefined;

      try {
        // Scoped by script id as well as version id: a version of another
        // script is as absent as one that does not exist (FR-006).
        const result = await client.query<VersionRow>(
          `SELECT id, script_id, content, origin, created_at
             FROM script_versions
            WHERE id = $1 AND script_id = $2`,
          [versionId, scriptId],
        );

        version = result.rows[0];
      } catch (error) {
        if (isInvalidUuid(error)) {
          throw new RepositoryError(
            "not_found",
            `No version exists with id "${versionId}"`,
          );
        }

        throw error;
      }

      if (!version) {
        throw new RepositoryError(
          "not_found",
          `No version exists with id "${versionId}"`,
        );
      }

      const written = await writeContentInTransaction(
        client,
        scriptId,
        version.content,
        "user",
      );

      await client.query("COMMIT");

      return { ...written, content: version.content };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original failure is the one worth reporting.
      });

      throw error;
    } finally {
      client.release();
    }
  }

  async get(scriptId: ScriptId, versionId: ScriptVersionId): Promise<ScriptVersion> {
    let row: VersionRow | undefined;

    try {
      const result = await getPool().query<VersionRow>(
        `SELECT id, script_id, content, origin, created_at
           FROM script_versions
          WHERE id = $1 AND script_id = $2`,
        [versionId, scriptId],
      );

      row = result.rows[0];
    } catch (error) {
      if (isInvalidUuid(error)) {
        throw new RepositoryError(
          "not_found",
          `No version exists with id "${versionId}"`,
        );
      }

      throw error;
    }

    if (!row) {
      throw new RepositoryError("not_found", `No version exists with id "${versionId}"`);
    }

    return toVersion(row);
  }
}
