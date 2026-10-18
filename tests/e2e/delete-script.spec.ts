import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Deleting a script (FR-001d, US3; spec Edge Cases).
 *
 * Through the real UI: the first click asks, cancelling removes nothing, and
 * confirming removes the script, its conversation, its messages, and its
 * version history together, returning the workspace to the list with nothing
 * selected. A sibling script is present throughout, so "the rows are gone"
 * cannot be confused with "the rows are". Registers no route handlers, so
 * Playwright's browser-context isolation keeps it independent of other specs.
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

function countRows(sql: string, scriptId: string): number {
  const connectionString = databaseUrl();

  if (connectionString === "") {
    throw new Error("DATABASE_URL must be set so the delete spec can check the cascade");
  }

  const output = execFileSync(
    "psql",
    [connectionString, "-tAc", sql.replace(/\$script/g, `'${scriptId}'`)],
    { stdio: "pipe" },
  )
    .toString()
    .trim();

  return Number(output);
}

function rowsFor(scriptId: string) {
  return {
    scripts: countRows("SELECT count(*) FROM scripts WHERE id = $script", scriptId),
    conversations: countRows(
      "SELECT count(*) FROM conversations WHERE script_id = $script",
      scriptId,
    ),
    messages: countRows(
      "SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.script_id = $script",
      scriptId,
    ),
    versions: countRows(
      "SELECT count(*) FROM script_versions WHERE script_id = $script",
      scriptId,
    ),
  };
}

async function createScript(
  page: Page,
  title: string,
): Promise<{ id: string; title: string }> {
  const created = await page.request.post("/api/scripts", { data: { title } });
  const { data } = (await created.json()) as { data: { id: string } };

  const opened = await page.request.get(`/api/scripts/${data.id}`);
  const { data: script } = (await opened.json()) as {
    data: { id: string; title: string; updatedAt: string };
  };

  // A save gives the script a version and a conversation message, so the
  // cascade has something to remove.
  await page.request.put(`/api/scripts/${script.id}/content`, {
    data: {
      content: "A paragraph that will be deleted.",
      baseUpdatedAt: script.updatedAt,
    },
  });

  return { id: script.id, title: script.title };
}

test.describe("deleting the script being viewed", () => {
  test("asks first, then removes everything and returns to the list", async ({
    page,
  }) => {
    await page.goto("/");

    const doomed = await createScript(page, `Doomed ${Date.now()}`);
    const kept = await createScript(page, `Kept ${Date.now()}`);

    expect(rowsFor(doomed.id)).toEqual({
      scripts: 1,
      conversations: 1,
      messages: 0,
      versions: 1,
    });

    await page.reload();
    await page
      .getByRole("navigation", { name: /scripts/i })
      .getByRole("button", { name: doomed.title, exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: /script/i })).toContainText(
      "A paragraph that will be deleted.",
    );

    // The first click only asks.
    await page.getByRole("button", { name: `Delete ${doomed.title}` }).click();
    await expect(page.getByRole("alertdialog")).toContainText("cannot be undone");
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(rowsFor(doomed.id).scripts).toBe(1);

    // Confirming removes it.
    await page.getByRole("button", { name: `Delete ${doomed.title}` }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^delete$/i })
      .click();

    await expect(
      page
        .getByRole("navigation", { name: /scripts/i })
        .getByRole("button", { name: doomed.title, exact: true }),
    ).toHaveCount(0);

    expect(rowsFor(doomed.id)).toEqual({
      scripts: 0,
      conversations: 0,
      messages: 0,
      versions: 0,
    });
    expect(rowsFor(kept.id).scripts).toBe(1);

    // Nothing of the deleted script is still on screen or selected.
    await expect(page.getByRole("main", { name: /editor/i })).toContainText(
      /select a script|start writing/i,
    );
    await expect(page.getByRole("textbox", { name: /script/i })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /conversation/i }).getByRole("log"),
    ).toHaveCount(0);

    // The sibling script is still openable.
    await page
      .getByRole("navigation", { name: /scripts/i })
      .getByRole("button", { name: kept.title, exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: /script/i })).toContainText(
      "A paragraph that will be deleted.",
    );
  });
});
