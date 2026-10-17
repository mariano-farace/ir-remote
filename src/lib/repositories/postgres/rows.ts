/**
 * Row-to-domain mapping for the PostgreSQL repositories.
 *
 * Kept separate so every repository maps dates the same way: `pg` hands back a
 * `Date` for `timestamptz`, while the domain and the HTTP layer speak ISO 8601
 * strings. Doing that conversion in one place keeps it out of each query.
 */

import type { IsoTimestamp, MessageRole, RevisionOrigin } from "@/lib/domain/types";

/** A `timestamptz` column as `pg` returns it. */
export type TimestampColumn = Date | string;

/**
 * Converts a `timestamptz` column to the ISO string the domain uses.
 *
 * An already-ISO string is normalized through `Date` so a value returned by a
 * raw `psql` invocation and one returned by `pg` are indistinguishable.
 */
export function toIso(timestamp: TimestampColumn): IsoTimestamp {
  return (typeof timestamp === "string" ? new Date(timestamp) : timestamp).toISOString();
}

/** Narrows a text column to the persisted speaker set. */
export function toRole(value: string): MessageRole {
  if (value === "user" || value === "assistant") {
    return value;
  }

  // The `messages_role_valid` constraint makes this unreachable through the
  // repository; reaching it means the row was written by something else.
  throw new Error(`Unexpected message role in the database: ${value}`);
}

/** Narrows a text column to the persisted revision-origin set. */
export function toRevisionOrigin(value: string): RevisionOrigin {
  if (value === "user" || value === "assistant") {
    return value;
  }

  throw new Error(`Unexpected revision origin in the database: ${value}`);
}
