import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as styles from "@/app/api/styles/route";
import { GET as getScript } from "@/app/api/scripts/[id]/route";
import { POST as createScript } from "@/app/api/scripts/route";
import { PostgresStyleRepository } from "@/lib/repositories/postgres/style-repository";

import { callRoute, field, jsonRequest } from "../support/api";
import { closeTestDatabase, resetDatabase } from "../support/fixtures";

/**
 * The style catalogue is shipped content the user chooses from (FR-007,
 * FR-010): the whole predefined set is offered, nothing but reading is
 * possible, and the style a script has is part of the script.
 */

const repository = new PostgresStyleRepository();

const URL = "http://localhost:3000/api/styles";

async function getStyles() {
  return callRoute(styles.GET, jsonRequest(URL, "GET"));
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

describe("GET /api/styles", () => {
  it("returns every style in the seeded catalogue", async () => {
    const seeded = await repository.list();
    const response = await getStyles();

    expect(response.status).toBe(200);
    expect(
      (field(response.json, "data") as ReadonlyArray<{ id: string }>).map(
        (style) => style.id,
      ),
    ).toEqual(seeded.map((style) => style.id));
  });

  it("offers nothing but the catalogue: no guidance, no way to change it", async () => {
    const response = await getStyles();
    const data = field(response.json, "data") as ReadonlyArray<Record<string, unknown>>;

    for (const style of data) {
      expect(Object.keys(style).sort()).toEqual(["description", "id", "name"]);
    }
  });
});

describe("no verb other than GET is handled", () => {
  it("has no create, edit, or delete handler at all", () => {
    // FR-008: styles are fixed content, not user data. The absence of the
    // handlers is the whole guarantee — there is no endpoint to call.
    expect((styles as Record<string, unknown>).POST).toBeUndefined();
    expect((styles as Record<string, unknown>).PUT).toBeUndefined();
    expect((styles as Record<string, unknown>).PATCH).toBeUndefined();
    expect((styles as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("the style applied to a script", () => {
  it("is returned with the script (FR-010)", async () => {
    const styleId = (await repository.list())[0]?.id;

    const created = await callRoute(
      createScript,
      jsonRequest("http://localhost:3000/api/scripts", "POST", { title: "Styled" }),
    );
    const id = field(field(created.json, "data"), "id") as string;

    const response = await callRoute(
      (request: Parameters<typeof getScript>[0]) =>
        getScript(request, { params: Promise.resolve({ id }) }),
      jsonRequest(`http://localhost:3000/api/scripts/${id}`, "GET"),
    );

    expect(field(field(response.json, "data"), "styleId")).toBe(styleId);
  });
});
