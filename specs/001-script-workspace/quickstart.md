# Quickstart: Script Workspace

**Feature**: `001-script-workspace` | **Date**: 2026-10-17

A validation guide: how to run the application and prove each success criterion holds.
Implementation detail lives in `tasks.md`; this document is about *proving it works*.

## Prerequisites

- Node.js 22 LTS (minimum 22.12 for Vitest 5) and npm 10
- Docker (for the local PostgreSQL container and Testcontainers)
- An OpenRouter API key, exported as `OPENROUTER_API_KEY`
- A model slug, exported as `OPENROUTER_MODEL` (e.g. `anthropic/claude-sonnet-4.5`)

## Setup

```bash
npm install
docker compose up -d db          # PostgreSQL on localhost:5432
npm run db:migrate               # apply migrations
npm run db:seed                  # load the static style catalogue
export OPENROUTER_API_KEY="..."
export OPENROUTER_MODEL="anthropic/claude-sonnet-4.5"
npm run dev                      # http://localhost:3000
```

The app MUST refuse to start when `OPENROUTER_API_KEY` or `OPENROUTER_MODEL` is missing,
printing a clear error.

**Before relying on any model**: confirm the chosen slug supports tool calling on
OpenRouter. Tool-calling support is model-dependent; the workspace fails closed (a visible
error) when a model cannot produce a valid revision, but picking a model without tool
support makes the feature unusable rather than unsafe.

## Running the checks

```bash
npm run test          # Vitest: unit + integration + contract
npm run test:coverage # enforces the 80% per-module floor (constitution Principle II)
npm run test:e2e      # Playwright: critical flows
```

## Validation Scenarios

Each scenario maps to a success criterion from [spec.md](./spec.md).

### V1 — Empty workspace to first draft (SC-001, SC-002)

1. Open the workspace with no scripts.
2. Click "Create new script". Expect: sidebar gains an entry, editor is empty, chat has no
   messages.
3. Select a style, type a topic, send it.
4. Expect: text streams into the **editor**, not into the chat. The chat shows the topic
   and a one-line summary. No copy-paste was involved.
5. Reload the page. Expect: the text is still there.

**Fails if** the script appears as a chat message, or the editor stays empty until the
request completes.

### V2 — Targeted revision preserves the rest (SC-009)

1. Generate a script long enough to have several paragraphs.
2. Note the text of every paragraph except the first.
3. Ask: "cut the introduction to two sentences".
4. Expect: paragraph one changed; **every other paragraph is byte-identical**.

**Fails if** any untouched paragraph differs by even one character.

### V3 — Stale revision is refused (SC-010)

1. Generate a script.
2. Start a revision request.
3. Before it applies, type a change into the very paragraph being revised.
4. Expect: the workspace reports that the document changed underneath the request and does
   **not** apply the revision over your edit.

**Fails if** your typed edit disappears, or the revision is applied against the old text.

### V4 — Nothing is lost (SC-005, and constitution Recoverability)

1. Ask the AI for a full rewrite of a script you have edited by hand.
2. Expect: you can undo it in one action, and the pre-rewrite version is available in
   version history.
3. Separately, send a prompt likely to yield an empty result. Expect: the script is not
   cleared.

**Fails if** either recovery path is missing.

### V5 — Reopening restores both text and conversation (SC-003, SC-008)

1. Create and generate two scripts with distinct topics.
2. Reload the workspace and open each in turn.
3. Expect: each script restores exactly its own text and its own conversation; neither is
   contaminated by the other.
4. Issue a follow-up prompt in a reopened script. Expect: the assistant's answer reflects
   that script's prior conversation.

### V6 — Style shapes responses and stays hidden (FR-010, FR-011)

1. Generate a script under one style; switch to another; ask for a change.
2. Expect: the register changes; existing text is unchanged; the style's instructions never
   appear as a chat message.

### V7 — Failures are visible, document survives (SC-006)

1. Unset `OPENROUTER_API_KEY` and start the app. Expect: startup fails with a clear
   message.
2. Set `OPENROUTER_MODEL` to a slug without tool-calling support and send a prompt. Expect:
   a visible error, not a silent no-op.
3. With the app running, point the provider at an unreachable host and send a prompt.
4. Expect: a visible error within 30 seconds; the script text is unchanged; the UI leaves
   its pending state.

### V8 — Save failures are honest (FR-005)

1. Stop the database container while the app is running.
2. Type in the editor.
3. Expect: the save indicator reports failure. It must not claim the document is saved.
4. Restart the database. Expect: recovery is visible, and no edit was silently dropped.

## Contract Checks

Run alongside the scenarios, not instead of them:

- [tool-call contract](./contracts/tool-call.md) — malformed payloads, ambiguous anchors,
  stale regions, and unauthorised `confirmedClear` are all rejected without mutating state.
- [HTTP API contract](./contracts/http-api.md) — `409 stale_write` on autosave behind the
  stored version; no `guidance` field in any response.
