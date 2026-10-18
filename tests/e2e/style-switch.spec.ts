import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildSystemPrompt } from "@/lib/ai/prompt";

import { expect, test, type Page } from "@playwright/test";

/**
 * V6 of quickstart.md (FR-009, FR-010, FR-011), US4.
 *
 * Generate a script under one style, switch it, and ask for a change. The
 * The chat request the workspace makes is what proves the style reached the
 * model: it carries no style at all (the route reads the association from the
 * database on every turn, T072's contract), so the proof is the stored
 * association, then the system prompt the route's own builder produces from
 * that association and the stored document, which is exactly what the route
 * passes to the model as `system`. The browser's turn is then settled with a
 * short answer so the conversation can continue without a real model call.
 *
 * The style's guidance is application configuration (FR-011), read here from the
 * database the seed wrote, and it must never appear in a chat message.
 *
 * Requires the setup described in `first-draft.spec.ts`, and `DATABASE_URL`
 * (the one the app uses) for the guidance text, which no endpoint exposes, and
 * for the stored style association, which must change rather than merely look
 * changed on screen.
 */

interface ScriptData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly styleId: string | null;
  readonly updatedAt: string;
}

function databaseUrl(): string {
  const fromEnvironment = process.env.DATABASE_URL?.trim() ?? "";

  if (fromEnvironment !== "") {
    return fromEnvironment;
  }

  const envFile = path.join(process.cwd(), ".env");

  if (!existsSync(envFile)) {
    return "";
  }

  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((entry) => entry.trim().startsWith("DATABASE_URL="));

  return (
    line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "") ?? ""
  );
}

/** Reads one value from PostgreSQL, or throws: a missing database is a setup error. */
function query(sql: string): string {
  const connectionString = databaseUrl();

  if (connectionString === "") {
    throw new Error("DATABASE_URL must be set so the style spec can read the catalogue");
  }

  return execFileSync(
    "psql",
    [connectionString, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

/** The style id a script is associated with, read straight from the row (FR-009). */
function storedStyleId(scriptId: string): string | null {
  const value = query(
    `SELECT coalesce(style_id, '') FROM scripts WHERE id = '${scriptId}'`,
  );

  return value === "" ? null : value;
}

async function storedScript(page: Page, scriptId: string): Promise<ScriptData> {
  const response = await page.request.get(`/api/scripts/${scriptId}`);

  return ((await response.json()) as { data: ScriptData }).data;
}

test.describe("V6 — style shapes responses and stays hidden", () => {
  test("switching the style leaves the text as it is and shapes the next request", async ({
    page,
  }) => {
    await page.goto("/");

    // The catalogue is read through the app the workspace itself queries, so
    // the test needs no second connection to the database.
    const listed = await page.request.get("/api/styles");
    expect(listed.status()).toBe(200);
    const summaries = (
      (await listed.json()) as {
        data: Array<{ id: string; name: string }>;
      }
    ).data;

    expect(
      summaries.length,
      "the seeded catalogue has at least two styles",
    ).toBeGreaterThan(1);
    const [original, replacement] = summaries as [
      { id: string; name: string },
      { id: string; name: string },
    ];
    // The guidance itself is configuration the client never sees (FR-011),
    // read from the seeded catalogue that the web server is using.
    const guidanceOf = (styleId: string): string =>
      query(`SELECT guidance FROM styles WHERE id = '${styleId}'`);

    // 1. A script with existing text, under the catalogue's first style.
    const created = await page.request.post("/api/scripts", {
      data: { title: `Style switch ${Date.now()}`, styleId: original.id },
    });
    const createdBody = (await created.json()) as { data: { id: string } };
    const opened = await page.request.get(`/api/scripts/${createdBody.data.id}`);
    // The document is written from the timestamp the server just reported, as
    // the workspace's own save path does.
    const { data: script } = (await opened.json()) as {
      data: ScriptData & { conversationId: string };
    };

    const DRAFT = [
      "# The Salt Roads",
      "Camel caravans crossed the Sahara for a thousand years, carrying slabs of salt a man could not lift alone.",
      "The salt was currency in Timbuktu. A house could be bought with it, and the caravans that brought it were the roads.",
    ].join("\n\n");

    const stored = await page.request.put(`/api/scripts/${script.id}/content`, {
      data: { content: DRAFT, baseUpdatedAt: script.updatedAt },
    });
    expect(stored.status()).toBe(200);

    // Seed the prior turn so the switch has a conversation to leave alone.
    query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ('${script.conversationId}', 'user', 'Write about the Saharan salt caravans.'),
              ('${script.conversationId}', 'assistant', 'Wrote a first draft about the Saharan salt caravans.')`,
    );

    await page.reload();
    await page
      .getByRole("navigation", { name: /scripts/i })
      .getByRole("button", { name: script.title, exact: true })
      .click();

    const sidebar = page.getByRole("navigation", { name: /scripts/i });
    // A combobox: the label text alone also matches the surrounding element.
    const styleSelector = sidebar.getByRole("combobox", { name: /style/i });
    const editor = page.getByRole("textbox", { name: /script/i });
    const chat = page.getByRole("log", { name: /conversation/i });

    await expect(editor).toContainText("Camel caravans");
    await expect(styleSelector).toHaveValue(original.id);
    await expect(styleSelector.locator("option")).toHaveCount(summaries.length);

    // 2. Switch the style: exactly that one becomes associated, replacing the
    // earlier choice rather than adding a second (FR-009).
    await styleSelector.selectOption(replacement.id);

    await expect
      .poll(async () => storedStyleId(script.id), {
        timeout: 10_000,
        message: "the style change was never saved",
      })
      .toBe(replacement.id);
    await expect(styleSelector).toHaveValue(replacement.id);

    // The existing text is unchanged by the switch.
    await expect(editor).toContainText(DRAFT.split("\n\n")[2] ?? "");
    expect((await storedScript(page, script.id)).content).toBe(DRAFT);

    // 3. Ask for a change.
    let requested = false;

    // The model is not reached: this scenario is about what shapes the request,
    // not about the model's prose, so the turn is settled with a short answer.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      requested = true;

      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
        body: [
          'data: {"type":"start"}',
          "",
          'data: {"type":"text-start","id":"t1"}',
          "",
          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "Kept the caravans, changed the register." })}`,
          "",
          'data: {"type":"text-end","id":"t1"}',
          "",
          'data: {"type":"finish"}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      });
    });

    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Make the opening colder in tone. Change nothing else about the facts.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // 4. The new style shapes the next request. The system prompt the route
    // builds is the function of exactly two server-side inputs — the associated
    // style and the stored document — both read here from their real sources.
    await expect.poll(() => requested, { timeout: 20_000 }).toBe(true);

    const current = await storedScript(page, script.id);
    const associated = summaries.find((style) => style.id === current.styleId);

    expect(associated?.id).toBe(replacement.id);

    const prompt = buildSystemPrompt({
      style: {
        id: replacement.id,
        name: replacement.name,
        description: "",
        guidance: guidanceOf(replacement.id),
      },
      document: current.content,
    });

    expect(prompt).toContain(guidanceOf(replacement.id));
    expect(prompt).not.toContain(guidanceOf(original.id));

    // ...while the style itself never appears as a chat message (FR-011).
    await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(chat).toContainText("Kept the caravans, changed the register.");
    for (const style of summaries) {
      await expect(chat).not.toContainText(guidanceOf(style.id));
    }
  });
});
