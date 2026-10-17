import { afterEach, describe, expect, it } from "vitest";

import { getPool, resetPoolForTests } from "@/lib/repositories/postgres/pool";

const DATABASE_URL = "postgres://narrative:narrative@localhost:5432/narrative_engine";

/** The global the pool is parked on, read through the same shape the module writes. */
function cachedPool(): unknown {
  return (globalThis as unknown as { __narrativeEnginePool?: unknown })
    .__narrativeEnginePool;
}

afterEach(async () => {
  await resetPoolForTests();
});

describe("getPool", () => {
  it("returns the same instance on repeated calls, so hot reload does not leak connections", () => {
    const first = getPool(DATABASE_URL);
    const second = getPool(DATABASE_URL);

    expect(second).toBe(first);
  });

  it("returns the same instance across a module re-import", async () => {
    const first = getPool(DATABASE_URL);
    const reimported = await import("@/lib/repositories/postgres/pool");

    expect(reimported.getPool(DATABASE_URL)).toBe(first);
  });

  it("caches on globalThis, so a fresh module instance reuses the pool", () => {
    const pool = getPool(DATABASE_URL);

    expect(cachedPool()).toBe(pool);
  });

  it("keeps one pool across differing connection strings and reports which URL it holds", () => {
    const pool = getPool(DATABASE_URL);
    const samePool = getPool("postgres://elsewhere:5432/other");

    expect(samePool).toBe(pool);
    expect(pool.options.connectionString).toBe(DATABASE_URL);
  });

  it("fails loudly when no connection string is configured", () => {
    expect(() => getPool("")).toThrowError(/DATABASE_URL|connection string/i);
    expect(() => getPool(undefined)).toThrowError(/DATABASE_URL|connection string/i);
  });

  it("survives an idle client error instead of crashing the process", async () => {
    const pool = getPool(DATABASE_URL);
    const listener = pool.listeners("error")[0];

    expect(listener).toBeTypeOf("function");
    // Emitting the event is what a dropped idle connection does. With no
    // listener, `pg` forwards it to an uncaught exception and the process dies.
    expect(() => pool.emit("error", new Error("idle client was dropped"))).not.toThrow();
  });

  it("resets the cache for tests and disposes the previous pool", async () => {
    const first = getPool(DATABASE_URL);
    await resetPoolForTests();
    const second = getPool(DATABASE_URL);

    expect(second).not.toBe(first);
    expect(first.ended).toBe(true);
    expect(cachedPool()).toBe(second);
  });
});
