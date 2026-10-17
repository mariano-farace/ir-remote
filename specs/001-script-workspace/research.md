# Research: Script Workspace

**Feature**: `001-script-workspace` | **Date**: 2026-10-17 | **Plan**: [plan.md](./plan.md)

Every version below was checked against the npm registry on 2026-10-17, not recalled.

## Version Baseline

| Package | Version | Note |
|---|---|---|
| `next` | 16.4.2 | Installed baseline is Next 16, not 15 |
| `react` | 19.3.1 | |
| `ai` | 7.0.143 | Vercel AI SDK |
| `@ai-sdk/react` | 4.0.147 | Separate package, own version line; peers `react ^18 \|\| ^19.2.1` |
| `@openrouter/ai-sdk-provider` | 3.1.0 | Community provider; peers `ai ^7`, `zod ^3.25.76 \|\| ^4.1.8` |
| `@tiptap/react` | 3.32.0 | |
| `zustand` | 5.x | |
| `vitest` | 5.0.5 | Requires Node `^22.12 \|\| ^24 \|\| >=26`; local Node is 22.21.1, which satisfies it |
| `@vitest/coverage-v8` | matching 5.x | |
| `@testcontainers/postgresql` | 12.2.1 | Requires Node >= 22.22 |
| `playwright` | 1.64.1 | |

`@ai-sdk/openrouter` does **not** exist on npm. The correct package is
`@openrouter/ai-sdk-provider`.

---

## Decision 1: Provider integration

**Decision**: `@openrouter/ai-sdk-provider@3.1.0` via `createOpenRouter()`. Base URL
`https://openrouter.ai/api/v1`, bearer auth, models addressed as `vendor/model` slugs.

**Rationale**: It handles OpenRouter-specific routing and provider options that the generic
`@ai-sdk/openai-compatible` would force us to hand-roll. Its peer dependency on `ai ^7`
matches the pinned SDK. Because the model slug is configuration
(`OPENROUTER_MODEL`), swapping models is an environment change — exactly what constitution
v1.3.0 requires.

**Alternatives considered**:
- `@ai-sdk/openai-compatible@3.0.71` — works, but loses OpenRouter routing and
  `providerOptions.openrouter`.
- Hardcoding a single vendor SDK (`@ai-sdk/deepseek`) — rejected: it re-pins the provider
  and would need a constitution amendment to change.

---

## Decision 2: How the document edit reaches the client

**Decision**: The tool is **server-executed**. `apply_document_revision` has an `execute`
on the server. The client applies the edit by reacting to the tool part reaching state
`output-available` in the assistant message.

**Rationale**: This is the documented v7 path for a server tool whose result the client
must act on. The client must *not* use `onToolCall` for this tool: `onToolCall` is for
client-side tools (those declared without `execute`), and using it here would execute the
edit twice.

**Alternatives considered**:
- Client-side tool + `addToolOutput` + `sendAutomaticallyWhen:
  lastAssistantMessageIsCompleteWithToolCalls` — the documented pattern for client-only
  tools, but it puts execution on the client, where the model's result would have to be
  trusted before validation. Rejected by Principle IV.
- `toDataStreamResponse()` — removed in v7; does not exist in the typings.

**v7 API notes that affect implementation**:
- `useChat` takes `transport` (a `DefaultChatTransport`, whose `api` defaults to
  `/api/chat`); `api` is no longer a top-level option.
- `useChat` still accepts `onFinish`, `onError`, `onData`, `messages`, `id`.
- `.toUIMessageStreamResponse()` is deprecated in 7.0 but present. The recommended route
  handler shape is:
  `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`.
- `result.fullStream` is now `result.stream`.
- `addToolResult` is deprecated in favour of `addToolOutput({ tool, toolCallId, output })`.
- Tool part states run `input-streaming` → `input-available` → `output-available` /
  `output-error`.

---

## Decision 3: Validating model output (Principle IV)

**Decision**: Zod schema on the tool's `inputSchema`, plus **semantic** validation on the
server after Zod passes, and a **second** validation on the client before the store mutates.

**Rationale**: Zod only proves the payload is shaped correctly. Our real risks are
semantic: `expectedText` not being a substring, an anchor appearing twice, a wholesale
draft against a non-empty document. The client re-validates because the browser document
may have changed between the server computing its answer and the client applying it.

**Known limitation, stated plainly**: schema failure is surfaced as `output-error`, but
there is **no documented automatic retry** on invalid tool input in AI SDK v7. We do not
invent one; the user sees the error and can retry. OpenRouter's `response-healing` plugin
does not help — it only repairs JSON for `response_format`, not tool-call arguments.

---

## Decision 4: Clearing the document requires user approval

**Decision**: Server-side `toolApproval` (v7, replaces `needsApproval`) for the destructive
case, resolved by the client with `addToolApprovalResponse`.

**Rationale**: `confirmedClear` cannot be a field the model sets — a prompt-injected model
would simply set it. Approval must be a separate user act. v7's `toolApproval` is the
built-in mechanism; inventing a custom confirm round-trip would be more code for the same
guarantee.

**Fallback if `toolApproval` proves awkward for a single tool**: a dedicated client
confirmation prompt that re-issues the request with an explicit user token. Either way, the
model never asserts user consent.

---

## Decision 5: Database access

**Decision**: `pg` (node-postgres) with a `Pool` cached on `globalThis`, and plain SQL
migrations checked into `db/migrations/`.

**Catalogue order (added T016/T017)**: `styles` carries an explicit `display_order`
column, seeded 10/20/30. spec.md's Assumptions make "the first style in the catalogue" the
default assigned to a new script, but every row in a single seed `INSERT` shares one
transaction timestamp, so ordering by `created_at` fell through to the id tiebreak and
produced alphabetical order. The default therefore depended on alphabetical happenstance
rather than a content decision. `display_order` makes it explicit and stable across reseeds.

**Rationale**: Constitution forbids speculative abstraction, and an ORM is exactly that for
this schema. The `globalThis` cache is required because the dev server hot-reloads modules
and would otherwise leak a pool per reload until Postgres refuses connections.

**Alternatives considered**:
- Prisma (stable 7.x) — schema DSL plus engine; too much machinery for six tables.
- Drizzle — a query builder the constitution would call speculative.
- porsager `postgres` — viable, smaller type ecosystem.

---

## Decision 6: Integration tests against a real database

**Decision**: Testcontainers (`@testcontainers/postgresql` 12.2.1), one container per test
run via Vitest `globalSetup`, tables truncated between tests.

**Rationale**: The schema depends on transactions and constraints, and the write path's
correctness argument depends on a revision being written before content changes. `pg-mem`
does not implement real transactions or advisory locks, so it would test a database that
behaves differently from production. One container per run keeps the fidelity and avoids a
multi-second start per file.

**Note**: Testcontainers 12 requires Node >= 22.22. Local Node is 22.21.1, which is one
patch below. The container startup MUST be verified on this machine before tasks depend on
it; if it fails, fall back to a Docker Compose service for integration tests, which has the
same fidelity.

**Verified 2026-10-17 (T017)**: `@testcontainers/postgresql@12.2.1` starts and stops a
`postgres:14.24-alpine` container correctly on Node 22.21.1. The engine mismatch is an
`npm install` warning only — no runtime check blocks it. **The Compose fallback is therefore
not used**, and integration tests run against Testcontainers with one container per run and
tables truncated between tests. Cost if wrong: if a future Testcontainers minor adds a real
runtime guard, integration tests fail loudly at startup rather than silently degrading, and
the documented fallback stays available.

**Note**: The container's SQL files are applied with `docker exec` into the image's own
`psql`, so no host `psql` install is assumed. `db/migrations/0001_initial.sql` and
`db/seed/styles.sql` are applied once per run by the Vitest `server` project's `globalSetup`.

---

## Decision 7: Test layout and coverage enforcement

**Decision**: Vitest 5 with two named projects — `unit` (jsdom, components and stores) and
`server` (node, route handlers and repositories) — and coverage thresholds declared
per-glob.

**Rationale**: Route handlers and repositories must not run in a jsdom environment, and
components do not need a database. Splitting by environment is cheaper and faster than
mocking one into the other. Coverage is declared per-glob because the constitution's floor
is per-module: a glob threshold in Vitest does **not** inherit the global setting, and
`perFile` must be set on each glob entry explicitly.

**Caveat**: Vitest cannot render async Server Components. Those are covered by Playwright,
not by unit tests.

---

## Decision 8: Autosave

**Decision**: A custom `useAutosave` hook implementing a trailing-edge debounce (800 ms)
over a single-flight loop, with a dirty flag re-checked after each save resolves.

**Rationale**: No library provides the three properties the constitution needs at once:
at most one in-flight request, no lost final edit, and an honest visible state. The loop
guarantees the first two; the save status drives the third (FR-005). Flush on unmount and
`visibilitychange`; use `keepalive` fetch on `beforeunload`.

**Alternatives considered**: `use-debounce`/`react-use` debounce alone — no in-flight
control. TanStack Query `useMutation` — helpful for `isPending`, but adds a dependency for
one endpoint's state.

---

## Decision 9: Markdown editing

**Decision**: TipTap 3.32.0 for editing, with Markdown as the persisted format.

**Rationale**: TipTap is pinned by the constitution. The persistence format is Markdown
because the spec names `.md` files (RU/FR-016 territory), and TipTap's document model is
richer than Markdown — so the Markdown round-trip (extension set, whitespace normalization)
is a genuine risk area that MUST have contract tests covering round-trip stability of the
supported Markdown subset.

**Open item for tasks**: confirm whether TipTap 3's Markdown support (official
`@tiptap/markdown` or a converter) is stable enough, or whether a converter
(marked + turndown) sits behind the editor. This is an implementation-level choice, not a
scope question, and does not block the plan.

---

## Decision 10: Sanitizing rendered Markdown

**Decision**: Sanitize on render with DOMPurify (isomorphic, for SSR safety) over the
TipTap/HTML pipeline.

**Rationale**: Principle IV forbids rendering model output as raw HTML. Even though TipTap
produces structured nodes, Markdown can carry inline HTML, and a model response is
untrusted input. Sanitization happens at the render boundary, not on save — saved text
stays faithful to what the user has.
