import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V5 of quickstart.md (SC-003, SC-008), US3.
 *
 * Create two scripts with distinct topics, reload the workspace, and open each
 * in turn. Each must restore exactly its own text *and* its own conversation;
 * neither may appear in the other. Then a follow-up prompt sent in a reopened
 * script must be answered with that script's own prior turns as context — the
 * route's request body is what proves the conversation, not the screen.
 *
 * Registers no route handlers, so Playwright's browser-context isolation
 * applies: the second reload starts from a fresh page and no request can be
 * held back by a handler a previous test installed.
 */

interface ScriptData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly updatedAt: string;
}

/** Two topics that share no vocabulary, so a stray paragraph is unmistakable. */
const SALT = {
  title: "Salt Roads",
  topic: "Write a short documentary script about the salt roads of the Sahara.",
  body: [
    "# The Salt Roads",
    "Camel caravans crossed the Sahara for a thousand years, carrying slabs of salt a man could not lift alone.",
    "The salt was currency in Timbuktu. A house could be bought with it, and the caravans that brought it were the roads.",
  ].join("\n\n"),
  turn: "Wrote a first draft about the Saharan salt caravans.",
};

const KODAK = {
  title: "Kodak Years",
  topic: "Write a short documentary script about the rise and fall of Kodak.",
  body: [
    "# The Kodak Years",
    "George Eastman founded the company in 1888 and sold photography the way the post office sold stamps.",
    "By 1975 an engineer named Steven Sasson had built the first digital camera, and management asked who would want one.",
  ].join("\n\n"),
  turn: "Wrote a first draft about the rise and fall of Kodak.",
};

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

function sql(...statements: string[]): void {
  const connectionString = databaseUrl();

  if (connectionString === "") {
    throw new Error(
      "DATABASE_URL must be set so the reopen spec can seed a conversation",
    );
  }

  execFileSync(
    "psql",
    [
      connectionString,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      ...statements.flatMap((statement) => ["-c", statement]),
    ],
    { stdio: "pipe" },
  );
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Writes both turns of a script's conversation directly, as use would leave them. */
function seedConversation(scriptId: string, topic: string, turn: string): void {
  sql(
    `INSERT INTO messages (conversation_id, role, content, created_at)
     VALUES ((SELECT id FROM conversations WHERE script_id = ${quote(scriptId)}), 'user', ${quote(topic)}, '2026-10-17T09:00:00.000Z'),
            ((SELECT id FROM conversations WHERE script_id = ${quote(scriptId)}), 'assistant', ${quote(turn)}, '2026-10-17T09:00:01.000Z')`,
  );
}

/** Creates a script whose stored document and conversation are the given ones. */
async function createScript(page: Page, seed: typeof SALT): Promise<ScriptData> {
  // The seeded fixtures below are matched on their document, not their title,
  // so the title only has to be unique.
  const created = await page.request.post("/api/scripts", {
    data: { title: `${seed.title} ${Date.now()}` },
  });
  const { data: script } = (await created.json()) as { data: ScriptData };

  const opened = await page.request.get(`/api/scripts/${script.id}`);
  const { data: current } = (await opened.json()) as { data: ScriptData };

  const stored = await page.request.put(
    `/api/scripts/${seed.title === SALT.title ? script.id : script.id}/content`,
    {
      data: { content: seed.body, baseUpdatedAt: current.updatedAt },
    },
  );
  expect(stored.status()).toBe(200);

  seedConversation(script.id, seed.topic, seed.turn);

  return { ...current, content: seed.body };
}

async function openFromSidebar(page: Page, title: string) {
  // Exact on purpose: each row also has a "Delete <title>" button, which a
  // non-exact match would find alongside the title button.
  const entry = page
    .getByRole("navigation", { name: /scripts/i })
    .getByRole("button", { name: title, exact: true });

  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "true");
}

test.describe("V5 — reopening restores each script's own text and conversation", () => {
  test("two scripts reopened in turn never show each other's text or turns", async ({
    page,
  }) => {
    await page.goto("/");

    const salt = await createScript(page, SALT);
    const kodak = await createScript(page, KODAK);

    // Two reloads: the first restores the list, the second proves nothing is
    // remembered in the page rather than in the database.
    await page.reload();
    await expect(
      page
        .getByRole("navigation", { name: /scripts/i })
        .getByRole("button", { name: salt.title, exact: true }),
    ).toBeVisible();
    await page.reload();

    const editor = page.getByRole("textbox", { name: /script/i });
    const chat = page.getByRole("log", { name: /conversation/i });

    for (const [own, other] of [
      [{ ...SALT, title: salt.title }, KODAK],
      [{ ...KODAK, title: kodak.title }, SALT],
      [{ ...SALT, title: salt.title }, KODAK],
    ] as const) {
      await openFromSidebar(page, own.title);

      // The editor holds this script's document and nothing of the other's.
      await expect(editor).toContainText(own.body.split("\n\n")[1] ?? "");
      for (const paragraph of other.body.split("\n\n")) {
        await expect(editor).not.toContainText(paragraph);
      }

      // The chat holds this script's turns and none of the other's.
      await expect(chat).toContainText(own.topic);
      await expect(chat).toContainText(own.turn);
      await expect(chat).not.toContainText(other.topic);
      await expect(chat).not.toContainText(other.turn);
      await expect(
        chat.getByRole("article", { name: "You" }).filter({ hasText: own.topic }),
      ).toHaveCount(1);
    }
  });

  test("a follow-up in a reopened script is sent with that script's own conversation", async ({
    page,
  }) => {
    await page.goto("/");

    const salt = await createScript(page, SALT);
    await createScript(page, KODAK);
    await page.reload();

    const { data: saltScript } = (await (
      await page.request.get(`/api/scripts/${salt.id}`)
    ).json()) as {
      data: ScriptData & { title: string; conversationId: string };
    };

    // Observe the request without holding it: the body is what the route
    // rebuilds the model's context from, so it is what proves continuity.
    const bodies: Array<Record<string, unknown>> = [];

    page.on("request", (request) => {
      if (request.url().endsWith("/api/chat") && request.method() === "POST") {
        bodies.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await openFromSidebar(page, saltScript.title);

    const followUp = "Make the opening colder without changing any other paragraph.";
    await page.getByRole("textbox", { name: /message/i }).fill(followUp);
    await page.getByRole("button", { name: /^send$/i }).click();

    await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible({
      timeout: 10_000,
    });

    // A real model answers in real time; the request has been made by now.
    await expect.poll(() => bodies.length, { timeout: 10_000 }).toBeGreaterThan(0);

    const body = bodies[0] ?? {};
    const messages = (body.messages ?? []) as Array<{
      role?: string;
      parts?: Array<{ type?: string; text?: string }>;
    }>;
    const sentText = messages.map(
      (message) => message.parts?.map((part) => part.text ?? "").join("") ?? "",
    );

    expect(body.scriptId).toBe(salt.id);
    expect(body.conversationId).toBe(saltScript.conversationId);
    expect(sentText).toContain(SALT.topic);
    expect(sentText).toContain(SALT.turn);
    expect(sentText).toContain(followUp);
    expect(sentText).not.toContain(KODAK.topic);
  });
});
