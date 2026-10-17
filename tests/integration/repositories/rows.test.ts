import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { toIso, toRevisionOrigin, toRole } from "@/lib/repositories/postgres/rows";

import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("toIso", () => {
  it("formats a Date from the driver as an ISO 8601 string", () => {
    expect(toIso(new Date("2026-10-17T12:00:00.000Z"))).toBe("2026-10-17T12:00:00.000Z");
  });

  it("normalizes a string timestamp to the same form as a Date", () => {
    expect(toIso("2026-10-17 12:00:00+00")).toBe(
      toIso(new Date("2026-10-17T12:00:00.000Z")),
    );
  });

  it("matches what the database hands back for a stored row", async () => {
    const inserted = await getTestPool().query<{ created_at: Date }>(
      "INSERT INTO scripts (title) VALUES ('Timestamps') RETURNING created_at",
    );
    const createdAt = inserted.rows[0]?.created_at;

    expect(createdAt).toBeInstanceOf(Date);
    expect(toIso(createdAt as Date)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("toRole", () => {
  it("passes through the two persisted speakers", () => {
    expect(toRole("user")).toBe("user");
    expect(toRole("assistant")).toBe("assistant");
  });

  it("rejects a speaker the schema forbids", () => {
    expect(() => toRole("system")).toThrowError(/Unexpected message role/);
  });
});

describe("toRevisionOrigin", () => {
  it("passes through the two write paths", () => {
    expect(toRevisionOrigin("user")).toBe("user");
    expect(toRevisionOrigin("assistant")).toBe("assistant");
  });

  it("rejects an origin the schema forbids", () => {
    expect(() => toRevisionOrigin("model")).toThrowError(/Unexpected revision origin/);
  });
});
