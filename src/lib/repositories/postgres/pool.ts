/**
 * The PostgreSQL connection pool, cached on `globalThis`.
 *
 * The Next.js dev server re-evaluates modules on hot reload. A module-scoped
 * pool would therefore leak one pool per reload until Postgres refuses new
 * connections, so the pool hangs off `globalThis` instead — the documented
 * node-postgres pattern for exactly this hazard.
 *
 * An idle client can be dropped by the server (a restart, a network blip). `pg`
 * reports that as an `error` event on the pool rather than on the query, and an
 * unhandled `error` event takes the process down. We attach a listener that
 * swallows that case: the next query opens a fresh connection, and a caller
 * still sees a real failure as a rejected promise.
 */

import { Pool } from "pg";

/** The shape parked on `globalThis`; one property, so the cache cannot collide. */
interface PoolCache {
  __narrativeEnginePool?: Pool;
}

function cache(): PoolCache {
  return globalThis as unknown as PoolCache;
}

function resolveConnectionString(connectionString: string | undefined): string {
  const value = connectionString?.trim() ?? "";

  if (value === "") {
    throw new Error(
      "Missing database connection string: DATABASE_URL is required to reach PostgreSQL",
    );
  }

  return value;
}

/**
 * Returns the process-wide pool, creating it on first call.
 *
 * @param connectionString Defaults to `process.env.DATABASE_URL`. The value is
 *   only read when the pool is created; a second call returns the cached pool.
 * @throws {Error} When no connection string is configured.
 */
export function getPool(connectionString: string = process.env.DATABASE_URL ?? ""): Pool {
  const existing = cache().__narrativeEnginePool;

  if (existing) {
    return existing;
  }

  const pool = new Pool({
    connectionString: resolveConnectionString(connectionString),
    // A single-user workspace never needs a wide fan-out, and a small ceiling
    // makes a leaked pool obvious instead of silently exhausting Postgres.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Without this listener a dropped idle client crashes the process.
  pool.on("error", () => {
    // Deliberately swallowed: the pool discards the dead client and the next
    // query opens a new one. A query that genuinely fails rejects its own
    // promise, which is where callers learn about it.
  });

  cache().__narrativeEnginePool = pool;

  return pool;
}

/**
 * Ends the cached pool and clears the cache. Test-only: production code never
 * tears the pool down, because a live request may still be holding a client.
 */
export async function resetPoolForTests(): Promise<void> {
  const existing = cache().__narrativeEnginePool;

  delete cache().__narrativeEnginePool;

  if (existing) {
    await existing.end();
  }
}
