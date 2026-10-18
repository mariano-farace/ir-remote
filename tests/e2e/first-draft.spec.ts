import { expect, test } from "@playwright/test";

/**
 * V1 of quickstart.md — empty workspace to first draft (SC-001, SC-002).
 *
 * This is a real end-to-end run against the configured model, not a stubbed
 * one: the failure mode that matters most here (a model that cannot produce a
 * valid tool call) only appears against a real provider. `playwright.config.ts`
 * builds and starts the app; the run therefore needs `DATABASE_URL` pointing at
 * PostgreSQL on localhost:5432 with the migration and seed applied, and
 * `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` in the environment — the shell's
 * environment, since the web server inherits it (see quickstart.md §Setup).
 *
 * Assertions target interactive roles and labels rather than CSS classes, so a
 * layout change does not break the test while a behaviour change does.
 */

const TOPIC = "The collapse of the Bronze Age trade networks";

/** A title unique to this run, so repeated local runs never collide (FR-001b). */
function uniqueTitle(): string {
  return `First draft ${Date.now()}`;
}

test.describe("V1 — first draft", () => {
  test("a topic prompt writes the draft into the editor, not the chat", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Create a script. The title is asked for before anything is created
    // (FR-001a) and the workspace does not invent one.
    const title = uniqueTitle();
    await page.getByRole("button", { name: /create new script/i }).click();
    const titleField = page.getByRole("textbox", { name: /title/i });
    await titleField.fill(title);
    await titleField.press("Enter");

    // 2. The script appears in the sidebar with an empty editor and empty chat.
    await expect(
      page.getByRole("navigation", { name: /scripts/i }).getByText(title),
    ).toBeVisible();

    const editor = page.getByRole("textbox", { name: /script/i });
    await expect(editor).toHaveText("");

    const chat = page.getByRole("log", { name: /conversation/i });
    await expect(chat.getByRole("article")).toHaveCount(0);

    // 3. Pick a style and send a topic. The first style is already assigned by
    // default (spec.md Assumptions); selecting it explicitly proves the
    // selector offers the predefined catalogue and nothing else.
    const styleSelector = page.getByRole("combobox", { name: /style/i });
    await expect(styleSelector.locator("option[value='']")).toHaveCount(0);
    await styleSelector.selectOption({ index: 0 });

    await page.getByRole("textbox", { name: /message/i }).fill(TOPIC);
    await page.getByRole("button", { name: /^send$/i }).click();

    // 4. The editor holds the draft. The read/wait happens before reading the
    // chat so the assertion describes what the writer sees once the turn ends.
    // The wait exceeds the route's own 60 s bound so a real generation that
    // takes most of that budget still has room to land in the editor (FR-023).
    await expect
      .poll(async () => (await editor.innerText()).trim().length, { timeout: 75_000 })
      .toBeGreaterThan(0);

    // The full script is not duplicated into the conversation (SC-002): the
    // user's topic is there, and the assistant's reply is at most a short
    // summary, not the document itself. The assertion is scoped to the user's
    // own message: the assistant's summary legitimately quotes the topic, so a
    // bare text match would resolve to two elements and prove nothing about
    // whose message it landed in.
    await expect(chat.getByRole("article", { name: /you/i })).toContainText(TOPIC);

    const draft = (await editor.innerText()).trim();
    const chatText = (await chat.innerText()).trim();

    expect(chatText).not.toContain(draft);
    expect(page.getByRole("textbox", { name: /message/i })).toBeEditable();

    // 5. Reload. US1's persistence claim (acceptance 5) is that the script is
    // still there: it lists again and reopens. The text coming back needs
    // autosave (US2, T052), and the conversation coming back needs restoration
    // (US3, T065), so neither is asserted here.
    await page.reload();
    // Exact name: the row's delete control is named "Delete <title>", so an
    // unanchored match resolves to two buttons and fails strict mode rather
    // than proving the script survived the reload.
    const entry = page
      .getByRole("navigation", { name: /scripts/i })
      .getByRole("button", { name: title, exact: true });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await expect(entry).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("textbox", { name: /script/i })).toBeVisible();
  });

  test("a blank title is refused and no script is created (US1 acceptance 2)", async ({
    page,
  }) => {
    // The workspace shows whatever scripts exist; this test only asserts that
    // none was *added* by the blank title, so the list is captured first.
    await page.goto("/");
    const list = page.getByRole("navigation", { name: /scripts/i }).getByRole("listitem");
    // The list loads on mount; the count is captured only after that load has
    // settled, or it would compare the final list against a subset of itself.
    await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/scripts") && response.request().method() === "GET",
    );
    const countBefore = await list.count();

    await page.getByRole("button", { name: /create new script/i }).click();

    const titleField = page.getByRole("textbox", { name: /title/i });
    await titleField.fill("   ");
    await titleField.press("Enter");

    // The user is told which rule broke and the prompt stays open; no script
    // is created until a valid title is supplied.
    // Scoped to the page body: Next.js keeps its own route announcer with
    // `role="alert"` outside `main`, and it is not this app's message.
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.locator("body > div").last().getByRole("alert")).toContainText(
      /title/i,
    );
    await expect(titleField).toBeVisible();
    // No script entry was created: the list is exactly as it was.
    await expect(list).toHaveCount(countBefore);
  });
});
