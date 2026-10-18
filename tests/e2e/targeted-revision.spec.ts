import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V2 and V3 of quickstart.md (SC-009, SC-010), US2.
 *
 * The revision is produced by the real model through the real `/api/chat`
 * route, because the claim is about what the *workspace* does with it: V2 says
 * the rest of the document is untouched, V3 says a change whose region moved is
 * refused. A stubbed tool call would only prove a stub runs. V3 holds the
 * browser's view of the chat request until the user has typed, so the edit
 * genuinely lands while the request is in flight rather than racing a fast
 * model. Both cases then read the stored document back, because "the editor
 * shows the right text" and "the document is right" are different claims.
 *
 * Requires the setup described in `first-draft.spec.ts`, and `DATABASE_URL`
 * (the one the app uses) so a revision can be seeded deterministically.
 */

/** The draft every V2/V3 script starts from; fixed, so "edit 1888" always names a real span. */
const DRAFT = [
  "# The Kodak Years",
  "George Eastman founded the company in 1888. He wanted photography to be as easy as using a pencil, and the box camera made that promise real for the first time.",
  "By 1975, a young engineer named Steven Sasson had built the first digital camera. Management greeted it with a mixture of curiosity and dismissal, asking who would ever want to look at photographs on a screen.",
  "The patents were valuable for a while. Then the world moved on, and the company that had invented the future found itself following it.",
].join("\n\n");

/** The paragraphs V2 expects to survive byte-for-byte: all but the first body paragraph. */
const UNTOUCHED = DRAFT.split("\n\n").filter(
  (paragraph) => !paragraph.startsWith("George Eastman"),
);

/** The prior turn the model reads for context. It summarises the draft, never carries it. */
const PRIOR_TURN = "Wrote a first draft of the Kodak story.";

interface ScriptData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly updatedAt: string;
}

function uniqueTitle(label: string): string {
  return `${label} ${Date.now()}`;
}

/**
 * The app's database, read the way `npm run db:migrate` reads it: `DATABASE_URL`
 * from the environment, or from the project's `.env` file when Playwright was
 * started without exporting it.
 */
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

/**
 * Appends an assistant turn to a script's conversation, the way `onFinish` does.
 *
 * `POST /api/chat` needs prior turns to answer with a revision of an existing
 * document, and how the model behaves when handed a topic on a seeded draft is
 * not the contract under test. Inserting the turn leaves the model one job:
 * read the draft and propose a targeted change.
 */
function seedAssistantTurn(scriptId: string, content: string): void {
  const connectionString = databaseUrl();

  if (connectionString === "") {
    throw new Error("DATABASE_URL must be set so the revision spec can seed a turn");
  }

  execFileSync(
    "psql",
    [
      connectionString,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-c",
      `INSERT INTO conversations (script_id) VALUES ('${scriptId}')
       ON CONFLICT (script_id) DO NOTHING;`,
      "-c",
      `INSERT INTO messages (conversation_id, role, content)
       VALUES (
         (SELECT id FROM conversations WHERE script_id = '${scriptId}'),
         'assistant',
         '${content.replace(/'/g, "''")}'
       );`,
    ],
    { stdio: "pipe" },
  );
}

/** Creates a script whose stored document is `DRAFT`. */
async function createSeededScript(page: Page, label: string): Promise<ScriptData> {
  const created = await page.request.post("/api/scripts", {
    data: { title: uniqueTitle(label) },
  });
  const { data: createdScript } = (await created.json()) as {
    data: { id: string };
  };

  // Creation's response carries the ids and the empty document, not the
  // script's `updatedAt`; the first save echoes the one the server has now.
  const opened = await page.request.get(`/api/scripts/${createdScript.id}`);
  const { data: script } = (await opened.json()) as { data: ScriptData };

  const stored = await page.request.put(`/api/scripts/${script.id}/content`, {
    data: { content: DRAFT, baseUpdatedAt: script.updatedAt },
  });
  expect(stored.status()).toBe(200);

  return script;
}

/** Reloads and opens the script from the sidebar, as a user returning to it would. */
async function reloadAndOpen(page: Page, script: ScriptData): Promise<void> {
  await page.reload();

  const entry = page
    .getByRole("navigation", { name: /scripts/i })
    .getByRole("button", { name: script.title, exact: true });

  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("textbox", { name: /script/i })).toContainText(
    "George Eastman",
  );

  // The prior turn is written after the script is open, and the route reads
  // the conversation from the database per request, so it is context for the
  // next prompt. It is deliberately not asserted on screen: restoring a
  // script's history into the panel is US3 (T065), not this phase's contract.
  seedAssistantTurn(script.id, PRIOR_TURN);
}

async function storedContent(page: Page, scriptId: string): Promise<string> {
  const response = await page.request.get(`/api/scripts/${scriptId}`);

  return ((await response.json()) as { data: ScriptData }).data.content;
}

test.describe("V2 — a targeted revision preserves everything it does not touch", () => {
  test("every paragraph outside the requested change is byte-identical afterwards", async ({
    page,
  }) => {
    await page.goto("/");
    const script = await createSeededScript(page, "Targeted revision");
    await reloadAndOpen(page, script);

    const editor = page.getByRole("textbox", { name: /script/i });
    const chat = page.getByRole("log", { name: /conversation/i });

    // Ask for a change to one paragraph only.
    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Cut the opening paragraph to two sentences. Change nothing else.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The turn settles and the stored document changed. A revision that was
    // refused is a failure here: V2 is about a revision that applies.
    await expect
      .poll(() => storedContent(page, script.id), {
        timeout: 60_000,
        message: "The revision was never applied to the stored document",
      })
      .not.toBe(DRAFT);
    await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible();

    // The chat carries a summary, not the script body (SC-002).
    await expect(chat).not.toContainText("box camera");

    const after = await storedContent(page, script.id);

    // Every untouched paragraph survives verbatim, in its original order.
    let cursor = 0;
    for (const paragraph of UNTOUCHED) {
      const found = after.indexOf(paragraph, cursor);

      expect(
        found,
        `A paragraph outside the change was altered or reordered:\n${paragraph}\n\n--- document ---\n${after}`,
      ).toBeGreaterThanOrEqual(cursor);
      cursor = found + paragraph.length;
    }

    // And the editor shows the document that was stored.
    await expect(editor).toContainText(UNTOUCHED[UNTOUCHED.length - 1] ?? "");
  });
});

test.describe("V3 — a stale revision is refused", () => {
  test("a revision whose target the user edited while it was in flight is not applied", async ({
    page,
  }) => {
    await page.goto("/");
    const script = await createSeededScript(page, "Stale revision");

    // Start the request, but hold it at the browser until the user has typed.
    // The server has not seen it yet, so the model reads the pre-edit document:
    // the revision's premise is stale by the time its answer arrives.
    let releaseRequest: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    await page.route("**/api/chat", async (route) => {
      await held;
      await route.continue();
    });

    await reloadAndOpen(page, script);

    const editor = page.getByRole("textbox", { name: /script/i });
    const chat = page.getByRole("log", { name: /conversation/i });
    const before = await storedContent(page, script.id);

    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Rewrite the opening paragraph so it is two sentences long.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Type into the very paragraph being revised: the founding year, which a
    // rewrite of that paragraph would necessarily replace.
    await expect(editor).toContainText("1888");
    const segment = editor.locator("p").filter({ hasText: "George Eastman" }).first();
    await segment.evaluate((paragraph) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();

      while (node) {
        const index = node.textContent?.indexOf("1888") ?? -1;

        if (index >= 0) {
          (node as Text).replaceData(index, 4, "1889");
          return;
        }

        node = walker.nextNode();
      }

      throw new Error("The founding year was not found in the paragraph");
    });
    await expect(editor).toContainText("1889");

    // Let the model's answer arrive.
    releaseRequest();

    // The turn settles: Stop is gone, Send is back, and the assistant answered
    // the prompt with a line rather than leaving it unanswered.
    await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(chat.getByRole("article", { name: "Assistant" }).last()).not.toBeEmpty();

    // The user's edit is still there: the stale revision was not applied on
    // top of it. *How* the refusal is shown is the error banner's contract
    // (T059), asserted there; here the guarantee is that the document wins.
    const editorText = await editor.innerText();

    expect(editorText).toContain("1889");
    expect(editorText).not.toContain("1888");

    // The stored document, once autosaved, is the user's edit — untouched by
    // the stale revision.
    await expect
      .poll(() => storedContent(page, script.id), { timeout: 10_000 })
      .toContain("1889");
    expect(await storedContent(page, script.id)).not.toBe(before);
  });
});
