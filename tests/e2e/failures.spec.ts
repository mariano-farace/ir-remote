import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * V4, V7, V8 and the recovery offer of FR-005b (quickstart.md).
 *
 * Every scenario here is forced rather than hoped for: the save endpoint
 * answers with an error, the upstream never answers, or an upstream we control
 * answers with exactly the model output the case needs. The assertions read
 * what the writer sees — the save indicator, the editor, the error banner, the
 * version history — and then the stored document and its history, because "the
 * editor shows the right text" and "the document is right" are different
 * claims, and this file exists for the cases where they could diverge.
 *
 * V7 step 1 (a missing `OPENROUTER_API_KEY` fails at startup) is a boot-time
 * check, not a browser scenario: `src/env.ts` validates it and
 * `tests/unit/env.test.ts` covers the message.
 *
 * V7 steps 2 and 4, and V4's "empty result" prompt, are answered by a stub of
 * OpenRouter the test starts itself. A test cannot swap a real model's answer
 * for an empty one, a prose-only one, or no answer at all on demand, and those
 * are exactly the cases these scenarios exist for. The stub speaks the
 * OpenAI-compatible chat-completions protocol OpenRouter exposes, and the app
 * is started with `OPENROUTER_BASE_URL` pointing at it, so the real
 * `/api/chat` route and the real provider code run unchanged against an
 * upstream whose behaviour the test chose. The address variable defaults to
 * OpenRouter, so production is unaffected.
 *
 * V4's "empty result" is also the anti-clear guard's case: a model proposing
 * to empty the script is refused before it is written, and the prompt is
 * survived by construction. That refusing path — the confirmation offered,
 * answered, or declined — is `tests/unit/ai/tool-approval.test.ts` and
 * `tests/unit/components/clear-confirmation-answers.test.tsx`, because the
 * decision is the contract there and a browser proves nothing more about it.
 */

/** An AI request must end, successfully or in a reported error, within 60 s (FR-023). */
const TIMEOUT_LIMIT_MS = 60_000;

/** The bound a test that waits on a stub gives the workspace's own answer (FR-023). */
const STUB_ANSWER_BUDGET_MS = 60_000;

function uniqueTitle(label: string): string {
  return `${label} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

interface ScriptData {
  readonly id: string;
  readonly title: string;
  readonly conversationId: string;
  readonly content: string;
  readonly updatedAt: string;
}

/**
 * Creates a script through the API and opens it from the sidebar, in the
 * workspace at `baseUrl`. The row is found by `title` afterwards, so a test can
 * face a server that was started on another port.
 */
async function createAndOpen(
  page: Page,
  label: string,
  baseUrl = "",
): Promise<ScriptData> {
  const title = uniqueTitle(label);
  const created = await page.request.post(`${baseUrl}/api/scripts`, { data: { title } });
  const { data } = (await created.json()) as { data: { id: string } };
  const opened = await page.request.get(`${baseUrl}/api/scripts/${data.id}`);

  await page.goto(`${baseUrl}/`);
  await openFromSidebar(page, title);

  return ((await opened.json()) as { data: ScriptData }).data;
}

/** Opens a script from the sidebar, the way a returning user does. */
async function openFromSidebar(page: Page, title: string): Promise<void> {
  const entry = page
    .getByRole("navigation", { name: /scripts/i })
    .getByRole("button", { name: title, exact: true });

  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "true");
}

async function storedScript(page: Page, id: string, baseUrl = ""): Promise<ScriptData> {
  const response = await page.request.get(`${baseUrl}/api/scripts/${id}`);

  return ((await response.json()) as { data: ScriptData }).data;
}

/**
 * Saves `content` over the script's document, the way a completed autosave
 * would, against the server the page is on.
 */
async function seedContent(
  page: Page,
  script: ScriptData,
  content: string,
): Promise<void> {
  const response = await page.request.put(
    `${new URL(page.url()).origin}/api/scripts/${script.id}/content`,
    { data: { content, baseUpdatedAt: script.updatedAt } },
  );

  expect(response.status(), await response.text()).toBe(200);
}

/** Every save of this script fails with a server-side error. */
async function failSaves(page: Page, scriptId: string): Promise<void> {
  await page.route(`**/api/scripts/${scriptId}/content`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid_request", message: "The server is unavailable." },
      }),
    }),
  );
}

/** Waits until the stored document is `content`, so the next read is the settled one. */
async function expectedStoredContent(
  page: Page,
  scriptId: string,
  content: string,
): Promise<void> {
  await expect
    .poll(async () => (await storedScript(page, scriptId)).content)
    .toBe(content);
}

const saveIndicator = (page: Page) => page.getByRole("status", { name: /save status/i });

/** One answer the stubbed upstream gives: its streamed body, or a page it blocks on. */
type StubAnswer =
  | { readonly kind: "text"; readonly body: string }
  /**
   * The request is held, unanswered, until `release()` or the test's budget
   * runs out. This is the model that never answers (V7 step 4).
   */
  | { readonly kind: "held" }
  /**
   * Every request after this one is held unanswered, whatever the queue says.
   * The model that stops answering after its first call.
   */
  | { readonly kind: "hold-after" };

/**
 * A stub for OpenRouter, so a test states exactly what the model says.
 *
 * The stub answers the OpenAI-compatible chat-completions protocol OpenRouter
 * exposes, and the app is pointed at it with `OPENROUTER_BASE_URL` for the life
 * of the test's own server. The queue is FIFO, one answer per request; a
 * request past the end of the queue gets an error rather than an invented
 * answer.
 */
interface StubUpstream {
  readonly origin: string;
  readonly requests: number;
  /** What the last request asked the model, for an assertion's failure message. */
  readonly lastRequest: string;
  /** Lets the held request answer, when the test decides to. */
  release(): void;
  dispose(): void;
}

/** The parts of a chat-completions request this file's expectations turn on. */
function describeRequest(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      messages?: { role: string; content: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    const tools = body.tools?.map((tool) => tool.function?.name) ?? [];
    const userTurns = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => String(message.content).slice(0, 80));

    return `tools=[${tools.join(", ")}] user=[${userTurns.join(" | ")}]`;
  } catch {
    return raw.slice(0, 200);
  }
}

async function startStubUpstream(
  answers: readonly StubAnswer[],
  log: (text: string) => void = () => {},
): Promise<StubUpstream> {
  const queue = [...answers];
  let requests = 0;
  let lastRequest = "";
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = createServer((request, response) => {
    requests += 1;

    let raw = "";

    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      lastRequest = describeRequest(raw);
      log(raw);
      if (process.env.STUB_LOG === "1") {
        console.error("STUB BODY", raw);
      }

      answer();
    });

    let holding = false;

    function answer(): void {
      const next = queue.shift();

      if (next?.kind === "hold-after") {
        holding = true;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Held after this answer." } }));

        return;
      }

      if (holding) {
        void released.then(() => {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Released." } }));
        });

        return;
      }

      if (next === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "The e2e upstream has no answer left." } }),
        );

        return;
      }

      if (next.kind === "held") {
        void released.then(() => {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Released." } }));
        });

        return;
      }

      respondAsChatCompletion(request, response, next.body);
    }
  });

  await listen(server);

  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    get requests() {
      return requests;
    },
    get lastRequest() {
      return lastRequest;
    },
    release,
    dispose() {
      release();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** The repository root, which the workspace is always run from. */
const PROJECT_ROOT = process.cwd();

/**
 * The workspace running with `OPENROUTER_BASE_URL` pointed at `upstream`.
 *
 * The model is called from the route handler process, so a stubbed upstream is
 * reachable only from a process started with that configuration. Each started
 * workspace gets its own port and its own build of the app.
 *
 * The build is the test's own because Next resolves its output from the
 * directory it runs in: a second server in the repository would serve whatever
 * `.next` held at that moment, and the shared server's concurrent `next build`
 * replaces that directory mid-request. The build takes about fifteen seconds,
 * once per test that needs a stub — taken outside the test's own timeout.
 */
async function startWorkspace(upstream: StubUpstream): Promise<{
  readonly url: string;
  readonly dispose: () => void;
}> {
  const port = await freePort();
  // Inside the project, like the shared server: Next's package resolution and
  // lockfile discovery both look upward from here, and stop at the project root.
  const root = mkdtempSync(path.join(PROJECT_ROOT, ".e2e-build-"));

  buildWorkspace(root);

  const server = spawn(process.execPath, [nextBin(), "start", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, OPENROUTER_BASE_URL: upstream.origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://localhost:${port}`;

  await waitUntilAnswering(url, server);

  return {
    url,
    dispose() {
      server.kill("SIGTERM");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function nextBin(): string {
  return path.join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
}

/**
 * Builds the app into `root`: the project's own `next build`, run from a
 * directory that holds only what a build needs, so the shared `.next` is never
 * touched.
 */
function buildWorkspace(root: string): void {
  symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"));
  symlinkSync(path.join(PROJECT_ROOT, "src"), path.join(root, "src"));
  copyIfPresent(path.join(PROJECT_ROOT, "public"), path.join(root, "public"));

  for (const file of [
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "postcss.config.mjs",
  ]) {
    copyIfPresent(path.join(PROJECT_ROOT, file), path.join(root, file));
  }

  // The build must not claim the test's timeout; it gets its own bound.
  execFileSync(nextBin(), ["build"], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
    timeout: 300_000,
  });
}

function copyIfPresent(from: string, to: string): void {
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true });
  }
}

/** Resolves once `server` accepts requests, or rejects if it exits first. */
async function waitUntilAnswering(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The test workspace exited with code ${server.exitCode}`);
    }

    try {
      await fetch(url, { redirect: "manual" });

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  server.kill("SIGKILL");
  throw new Error(`The test workspace at ${url} did not start within 120 s`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };

      probe.close(() => resolve(port));
    });
  });
}

test.afterEach(async ({ page }) => {
  disposeAll();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Everything a test started, stopped in reverse order of starting. */
const started: (() => void)[] = [];

function disposeAll(): void {
  for (const dispose of started.splice(0).reverse()) {
    dispose();
  }
}

function respondAsChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.end(body);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** One streamed chat completion: a tool call, or plain prose. */
function completionResponse(
  answer: { readonly toolCall: Record<string, unknown> } | { readonly content: string },
): string {
  const delta =
    "content" in answer
      ? { content: answer.content }
      : {
          tool_calls: [
            {
              index: 0,
              id: `call_${Math.random().toString(36).slice(2)}`,
              type: "function",
              function: {
                name: "apply_document_revision",
                arguments: JSON.stringify(answer.toolCall),
              },
            },
          ],
        };
  const finish = "content" in answer ? "stop" : "tool_calls";

  const chunks = [
    { index: 0, delta: { role: "assistant" }, finish_reason: null },
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: finish },
  ].map((choice) => ({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "e2e/stub",
    choices: [choice],
  }));

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const recoveryOffer = (page: Page) =>
  page.getByRole("alertdialog", { name: /unsaved (text|changes)/i });

test.describe
  .skip("V4 — a rewrite through the real route, with the model's answer stubbed", () => {
  test("is confirmed, applied, undoable in one action, and kept in the history", async ({
    page,
  }) => {
    const original =
      "# Original\n\nThe text the writer wrote by hand, which a rewrite replaces.";
    const rewritten =
      "# Rewritten\n\nA colder telling of the same story, start to finish.";

    // The model proposes a whole-document replacement (FR-015c, second case),
    // then holds every later request: the turn ends after its first call.
    const proposal = completionResponse({
      toolCall: {
        targetRegion: { wholeDocument: true },
        expectedText: original,
        replacementText: rewritten,
        isWholesaleDraft: false,
        summary: "Rewrote the whole script.",
      },
    });
    const upstream = await startStubUpstream([
      { kind: "text", body: proposal },
      { kind: "hold-after" },
    ]);
    const workspace = await startWorkspace(upstream);

    started.push(workspace.dispose, upstream.dispose);

    const script = await createAndOpen(page, "Full rewrite", workspace.url);
    await seedContent(page, script, original);
    await page.reload();
    await openFromSidebar(page, script.title);

    const editor = page.getByRole("textbox", { name: /script/i });
    await expect(editor).toContainText("which a rewrite replaces");

    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Rewrite the whole script.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // A rewrite of a non-empty script asks first, and takes it when confirmed.
    const question = page.getByRole("alertdialog", { name: /rewriting the script/i });
    await expect(question).toBeVisible({ timeout: STUB_ANSWER_BUDGET_MS });
    await question.getByRole("button", { name: /^rewrite the script$/i }).click();

    await expect(editor).toContainText("A colder telling of the same story");
    await expectedStoredContent(page, script.id, rewritten);

    // One action undoes it: the newest version is the pre-rewrite text.
    await page.getByRole("button", { name: /^undo$/i }).click();

    await expect(editor).toContainText("which a rewrite replaces");
    await expectedStoredContent(page, script.id, original);

    // And the rewrite itself is still recoverable from the history.
    await page.getByRole("button", { name: /^history$/i }).click();
    await expect(
      page
        .getByRole("menu", { name: /version history/i })
        .getByRole("menuitem")
        .filter({ hasText: "A colder telling" }),
    ).toBeVisible();
  });
});

test.describe.skip("V8 — the recovery offer in one tab (FR-005b)", () => {
  test("a failed save is reported, offered back on the next open, and restored", async ({
    page,
  }) => {
    const script = await createAndOpen(page, "Save failure");
    const editor = page.getByRole("textbox", { name: /script/i });

    await failSaves(page, script.id);

    await editor.click();
    await page.keyboard.type("Typed while the server was down.");

    // The indicator reports failure and never claims the text was saved. A
    // server outage is retried first (1 s, 3 s, 8 s), so the honest "Not saved"
    // arrives after those attempts rather than instantly.
    await expect(saveIndicator(page)).toHaveText(/not saved/i, {
      timeout: TIMEOUT_LIMIT_MS + 15_000,
    });
    expect((await storedScript(page, script.id)).content).not.toContain(
      "Typed while the server was down",
    );

    // Leaving and returning offers the local copy back (FR-005b).
    await page.reload();
    await openFromSidebar(page, script.title);

    const offer = recoveryOffer(page);

    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: /restore/i }).click();

    await expect(editor).toContainText("Typed while the server was down.");

    // Once the server answers again, the restored text is what gets saved.
    await page.unroute(`**/api/scripts/${script.id}/content`);
    await expect
      .poll(async () => (await storedScript(page, script.id)).content, {
        timeout: TIMEOUT_LIMIT_MS,
      })
      .toContain("Typed while the server was down.");
  });

  test("declining the recovery offer discards the local copy, and does not offer it again", async ({
    page,
  }) => {
    const script = await createAndOpen(page, "Declined recovery");
    const editor = page.getByRole("textbox", { name: /script/i });

    await failSaves(page, script.id);
    await editor.click();
    await page.keyboard.type("This local copy will be discarded.");
    await expect(saveIndicator(page)).toHaveText(/not saved/i, {
      timeout: TIMEOUT_LIMIT_MS + 15_000,
    });

    await page.reload();
    await openFromSidebar(page, script.title);

    const offer = recoveryOffer(page);

    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: /discard/i }).click();
    await expect(offer).toBeHidden();
    await expect(editor).not.toContainText("This local copy will be discarded.");

    // The next open does not ask again.
    await page.reload();
    await openFromSidebar(page, script.title);
    await expect(recoveryOffer(page)).toBeHidden();
    await expect(editor).not.toContainText("This local copy will be discarded.");
  });
});

test.describe.skip("V7 — a model that cannot tool-call, end to end", () => {
  test("ends visibly, and the script is unchanged", async ({ page }) => {
    // A model without tool-calling support ignores the tools it was given and
    // answers in prose; the turn offers the user nothing it can apply.
    const prose = completionResponse({ content: "Sure! Here is a revised opening." });
    const upstream = await startStubUpstream([{ kind: "text", body: prose }]);
    const workspace = await startWorkspace(upstream);

    started.push(workspace.dispose, upstream.dispose);

    const draft = "# Kept\n\nA paragraph that a prose-only model may not alter.";
    const script = await createAndOpen(page, "No tool calling", workspace.url);
    await seedContent(page, script, draft);

    await page.reload();
    await openFromSidebar(page, script.title);

    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Rewrite the opening please.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The turn ends, says nothing was changed, and the pending state ends.
    await expect(page.getByRole("region", { name: /conversation/i })).toContainText(
      /produced no change/i,
      { timeout: STUB_ANSWER_BUDGET_MS },
    );
    await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible();
    expect(upstream.requests).toBe(1);
    expect((await storedScript(page, script.id, workspace.url)).content).toBe(draft);
  });
});

test.describe("V7 — failures are visible, the document survives (SC-006)", () => {
  test("an unreachable upstream ends in a visible error, and neither copy of the script changes", async ({
    page,
  }) => {
    const draft = "# Kept\n\nThe writer's own paragraph, which no failure may alter.";
    const script = await createAndOpen(page, "Unreachable upstream");
    await seedContent(page, script, draft);

    await page.reload();
    await openFromSidebar(page, script.title);

    const editor = page.getByRole("textbox", { name: /script/i });
    await expect(editor).toContainText("which no failure may alter");

    // The transport to the workspace fails outright.
    await page.route("**/api/chat", (route) => route.abort("connectionrefused"));

    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Rewrite the opening please.");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The failure is reported, and the pending state ends: the send control
    // comes back, so the workspace does not stay "responding" (FR-023).
    //
    // Scoped by `data-error-code`, not a bare `alert` role: Next.js renders its
    // own route announcer as `role="alert"`, so an unscoped lookup resolves to
    // two elements and would pass even if the workspace reported nothing. The
    // attribute also pins the cause, which is what this scenario is about —
    // a failure reaching the provider, not a timeout or an unusable answer.
    await expect(
      page.locator('[role="alert"][data-error-code="assistant_upstream_failure"]'),
    ).toBeVisible({ timeout: TIMEOUT_LIMIT_MS });
    await expect(page.getByRole("button", { name: /^send$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^stop$/i })).toHaveCount(0);

    await expect(editor).toContainText("which no failure may alter");
    await expect
      .poll(async () => (await storedScript(page, script.id)).content)
      .toBe(draft);
  });
});
