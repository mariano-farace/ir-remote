/**
 * The integration-test database: one real PostgreSQL per test run.
 *
 * `pg-mem` is not used because the schema's correctness argument depends on
 * real transactions, expression indexes, and foreign-key cascades. A mock
 * database would test a database that behaves differently from production.
 *
 * The container is started once by `globalSetup`, the migration and seed are
 * applied once, and each test starts from truncated tables. Starting a
 * container per file would add several seconds per file for no extra fidelity.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const MIGRATION = fileURLToPath(
  new URL("../../../db/migrations/0001_initial.sql", import.meta.url),
);
const SEED = fileURLToPath(new URL("../../../db/seed/styles.sql", import.meta.url));

/** `psql` is not assumed to be installed; the image's own binary runs the files. */
export interface RunSqlFileOptions {
  /** Absolute path of the SQL file to run with `ON_ERROR_STOP=1`. */
  readonly file: string;
  /** The container's database URL. */
  readonly databaseUrl: string;
  /** The running container's id, used to exec `psql` inside the image. */
  readonly containerId: string;
}

/** Runs a checked-in SQL file inside the container's own `psql`. */
export function runSqlFile({ file, databaseUrl, containerId }: RunSqlFileOptions): void {
  const url = new URL(databaseUrl);
  const sql = readFileSync(file, "utf8");

  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerId,
      "psql",
      "--username",
      decodeURIComponent(url.username),
      "--dbname",
      decodeURIComponent(url.pathname.replace(/^\//, "")),
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    { input: sql, stdio: ["pipe", "pipe", "pipe"] },
  );
}

export const DATABASE_FILE_PATHS = {
  migration: MIGRATION,
  seed: SEED,
  repoRoot: REPO_ROOT,
};
