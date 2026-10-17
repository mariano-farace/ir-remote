/**
 * Vitest `globalSetup`: start one PostgreSQL container for the whole run.
 *
 * Applies `db/migrations/0001_initial.sql` and `db/seed/styles.sql` once, then
 * publishes the connection URL to the test processes. The container is torn
 * down in the returned teardown, so a failed run does not leak a container.
 */

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

import { DATABASE_FILE_PATHS, runSqlFile } from "./database";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer("postgres:14.24-alpine")
    .withDatabase("narrative_engine")
    .withUsername("narrative")
    .withPassword("narrative")
    .start();

  const databaseUrl = container.getConnectionUri();
  const containerId = container.getId();

  runSqlFile({ file: DATABASE_FILE_PATHS.migration, databaseUrl, containerId });
  runSqlFile({ file: DATABASE_FILE_PATHS.seed, databaseUrl, containerId });

  project.provide("databaseUrl", databaseUrl);

  return async () => {
    await container?.stop();
    container = undefined;
  };
}
