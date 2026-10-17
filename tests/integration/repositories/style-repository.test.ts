import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RepositoryError } from "@/lib/repositories/types";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { closeTestDatabase, getTestPool, resetDatabase } from "../support/fixtures";

const repository = new PostgresStyleRepository();

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("PostgresStyleRepository.list", () => {
  it("returns the seeded catalogue in insertion order", async () => {
    const styles = await repository.list();

    expect(styles.map((style) => style.id)).toEqual([
      "historical-documentary",
      "observational",
      "investigative",
    ]);
  });

  it("returns each style's name, description, and guidance", async () => {
    const [first] = await repository.list();

    expect(first).toMatchObject({
      id: "historical-documentary",
      name: "Historical Documentary",
    });
    expect(first?.description.length).toBeGreaterThan(0);
    // The guidance is repository surface; the HTTP layer strips it (FR-011).
    expect(first?.guidance.length).toBeGreaterThan(0);
  });

  it("is unaffected by rows in the script-owned tables", async () => {
    const pool = getTestPool();
    await pool.query(
      "INSERT INTO scripts (title, style_id) VALUES ('A Film', 'observational')",
    );

    const styles = await repository.list();

    expect(styles).toHaveLength(3);
  });
});

describe("PostgresStyleRepository.get", () => {
  it("returns the style for a known id", async () => {
    const style = await repository.get("investigative");

    expect(style.name).toBe("Investigative");
    expect(style.guidance).toMatch(/investigative/i);
  });

  it("reports not_found for an id that is not in the catalogue", async () => {
    await expect(repository.get("user-authored")).rejects.toBeInstanceOf(RepositoryError);
    await expect(repository.get("user-authored")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("the style repository offers no write path", () => {
  it("exposes only the read operations (FR-008)", () => {
    const surface = Object.getOwnPropertyNames(PostgresStyleRepository.prototype).filter(
      (name) => name !== "constructor",
    );

    expect(surface.sort()).toEqual(["get", "list"]);
  });
});
