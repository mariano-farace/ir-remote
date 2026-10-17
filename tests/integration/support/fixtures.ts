/**
 * Per-test isolation for the shared container.
 *
 * Every integration test starts from these facts:
 *   - the script-related tables are empty,
 *   - the seeded style catalogue is intact,
 *   - the cached pool points at the test container.
 *
 * Truncation runs `RESTART IDENTITY CASCADE` on the script-owned tables so one
 * test's rows never reach another, while leaving `styles` alone because it is
 * seeded content, not user data.
 */

import type { Pool } from "pg";
import { inject } from "vitest";

import { getPool, resetPoolForTests } from "@/lib/repositories/postgres/pool";

const SCRIPT_OWNED_TABLES = [
  "script_versions",
  "messages",
  "conversations",
  "scripts",
] as const;

/** The container URL, published by `global-setup.ts`. */
export function databaseUrl(): string {
  return inject("databaseUrl");
}

/** Points the cached pool at the test container, replacing any previous one. */
export async function pointPoolAtTestDatabase(): Promise<void> {
  await resetPoolForTests();
  getPool(databaseUrl());
}

/** Empties every script-owned table. Call from `beforeEach`. */
export async function truncateScriptTables(): Promise<void> {
  await getPool().query(
    `TRUNCATE TABLE ${SCRIPT_OWNED_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/** Empties script-owned tables and re-points the pool. Call from `beforeEach`. */
export async function resetDatabase(): Promise<void> {
  await pointPoolAtTestDatabase();
  await truncateScriptTables();
}

/** Closes the pool at the end of a test file. Call from `afterAll`. */
export async function closeTestDatabase(): Promise<void> {
  await resetPoolForTests();
}

/** The test pool, for assertions that need SQL directly rather than through a repository. */
export function getTestPool(): Pool {
  return getPool();
}

/** The id of the first seeded style, useful when a test just needs a valid style. */
export async function firstStyleId(): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    "SELECT id FROM styles ORDER BY display_order, id LIMIT 1",
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("The style catalogue is empty: db/seed/styles.sql was not applied");
  }

  return row.id;
}
