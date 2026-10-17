---

description: "Task list for Script Workspace implementation"
---

# Tasks: Script Workspace

**Input**: Design documents from `specs/001-script-workspace/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required. Constitution Principle I (Test-First, NON-NEGOTIABLE) and Principle II
(coverage > 80% per module) make tests mandatory, not optional. Every implementation task
is preceded by its failing test.

**Organization**: Tasks are grouped by user story so each story is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)

## Path Conventions

Single Next.js project per plan.md:

- Application source: `src/`
- Tests: `tests/unit`, `tests/integration`, `tests/contract`, `tests/e2e`
- Database: `db/migrations`, `db/seed`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and toolchain. No feature behavior yet.

- [x] T001 Initialize Next.js 16.4.2 + TypeScript project at repository root with `npm`, App Router enabled, `src/` directory layout, and dependency versions pinned exactly as listed in research.md §Version Baseline
- [x] T002 [P] Configure Tailwind CSS for the three-column workspace layout in `src/app/globals.css` and `tailwind.config.ts`
- [x] T003 [P] Create `vitest.config.mts` with two named projects: `unit` (jsdom, include `tests/unit/**/*.test.{ts,tsx}` — the brace form is required, since most unit tests are `.ts` and a `.tsx`-only glob silently skips them) and `server` (node, `tests/integration/**/*.test.ts`, `tests/contract/**/*.test.ts`), plus `@vitest/coverage-v8` with per-glob thresholds — global `lines/branches/functions/statements: 80`, `src/lib/domain/**` and `src/stores/**` at `95/90/90/95` with `perFile: true` on each glob explicitly (glob thresholds do not inherit global `perFile`)
- [x] T004 [P] Configure Playwright in `playwright.config.ts` with `webServer: { command: 'npm run build && npm run start', url: 'http://localhost:3000', timeout: 120_000 }` and `use: { baseURL, trace: 'on-first-retry' }`
- [x] T005 [P] Create `docker-compose.yml` with a PostgreSQL 14+ service on port 5432 for local development
- [x] T006 Create `src/env.ts` that validates required environment variables at startup: `OPENROUTER_API_KEY` (required) and `OPENROUTER_MODEL` (required). Missing values MUST throw a clear error naming the missing variable
- [x] T007 [P] Write `tests/unit/env.test.ts` covering: both variables present passes; each missing fails with a message naming that variable
- [x] T008 Create `db/migrations/0001_initial.sql` defining tables `scripts`, `conversations`, `messages`, `script_versions`, and `styles` per data-model.md, including the case-insensitive title uniqueness constraint on the normalized (lowercased, trimmed) title
- [x] T009 [P] Create `db/seed/styles.sql` with the static style catalogue (id, name, description, guidance)
- [x] T010 [P] Configure ESLint and Prettier in `eslint.config.mjs` and `.prettierrc` with the project's TypeScript/React rules

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Domain types, the repository boundary, and the connection pool. Every user
story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T011 Define domain types in `src/lib/domain/types.ts`: `Script`, `Style`, `Conversation`, `Message`, `ScriptVersion`, `PendingRevision` per data-model.md, with no framework imports
- [x] T012 Write `tests/unit/domain/types.test.ts` asserting the invariants that live in types alone: `Message.role` is restricted to `user | assistant`. Title rules are covered by T028 and T084; style immutability is covered by T070. Do not duplicate those here.
- [x] T013 Define repository interfaces in `src/lib/repositories/types.ts` covering scripts (list, create, get, rename, delete, updateContent), conversations (get messages, append), styles (list), and revisions (list, restore). These are the swap boundary required by MVP Scope Boundaries
- [x] T014 Create the PostgreSQL pool in `src/lib/repositories/postgres/pool.ts`, cached on `globalThis` so dev-server hot reload does not leak connections
- [x] T015 Write `tests/integration/repositories/pool.test.ts` asserting the pool returns the same instance on repeated imports and that an idle client error does not crash the process
- [x] T016 Implement `PostgresStyleRepository` in `src/lib/repositories/postgres/style-repository.ts`
- [x] T017 Write `tests/integration/repositories/style-repository.test.ts` against a real PostgreSQL via Testcontainers: listing returns the seeded catalogue; nothing in the interface allows create/update/delete. If Testcontainers 12 fails on this machine (Node 22.21.1 is below its 22.22 requirement), switch integration tests to the Compose service and record the switch in research.md
- [x] T018 Implement `PostgresScriptRepository.create` in `src/lib/repositories/postgres/script-repository.ts` creating the Script and its Conversation in one transaction
- [x] T019 Write `tests/integration/repositories/script-repository.test.ts` covering: create yields exactly one conversation; a duplicate normalized title violates the constraint and raises a distinguishable error; a script with no conversation is never observable
- [x] T020 Create `src/lib/ai/provider.ts` constructing the OpenRouter provider with `@openrouter/ai-sdk-provider` and the model slug from configuration. No model name may be hardcoded at a call site
- [x] T021 Write `tests/unit/ai/provider.test.ts` asserting the provider reads the model from configuration and that an empty or missing slug fails loudly rather than defaulting

**Checkpoint**: Domain types, repository boundary, pool, and provider exist and are tested.

---

## Phase 3: User Story 1 — Create a script and generate a first draft (Priority: P1)

**Goal**: Create a named script and get a first draft written into the editor by the AI.

**Independent Test**: From an empty workspace, create a script with a title, select a
style, send one topic prompt, and confirm the editor holds non-empty script text that
arrived without copy-paste.

### Tests for User Story 1

- [ ] T022 [P] [US1] Write `tests/contract/tool-call-schema.test.ts` validating `apply_document_revision` against contracts/tool-call.md: rejects a payload missing `expectedText`, rejects `summary` over 200 characters, accepts a valid wholesale draft against an empty document, rejects a wholesale draft against a non-empty document
- [ ] T023 [P] [US1] Write `tests/integration/api/scripts-create.test.ts` for `POST /api/scripts`: returns 201 with title, content, styleId and conversationId; blank title returns `400 title_required`; title over 200 characters is rejected; duplicate normalized title returns `409 title_taken`
- [ ] T024 [P] [US1] Write `tests/unit/stores/document-store.test.ts` covering initial state and that `applyProposal` is the only exported mutator
- [ ] T025 [US1] Write `tests/e2e/first-draft.spec.ts` (Playwright) implementing quickstart.md V1: create a script with a title, send a topic prompt, assert the editor receives the text and the chat does not contain the full script

### Implementation for User Story 1

- [ ] T026 [US1] Implement `Zustand` store in `src/stores/document-store.ts` holding the active script's content, save state, and a single `applyProposal(revision)` mutator. No other exported function may change content
- [ ] T027 [US1] Implement title validation in `src/lib/domain/title.ts`: trimmed, non-blank, 1–200 characters, normalized for uniqueness as lowercase+trim. Must fail with a distinct reason per rule
- [ ] T028 [P] [US1] Write `tests/unit/domain/title.test.ts` covering each rule independently, including `"My Film"` vs `"my film "` colliding and a 201-character title being rejected
- [ ] T029 [US1] Implement `GET /api/styles` in `src/app/api/styles/route.ts` returning the catalogue without `guidance`
- [ ] T030 [US1] Implement `POST /api/scripts` in `src/app/api/scripts/route.ts` per contracts/http-api.md, mapping constraint violations to `400 title_required` / `409 title_taken`
- [ ] T031 [US1] Implement `GET /api/scripts` in `src/app/api/scripts/route.ts` ordered by last modified, most recent first (FR-002)
- [ ] T032 [US1] Implement the AI tool definition in `src/lib/ai/tools.ts` using `tool({ inputSchema, execute })` with the Zod schema from contracts/tool-call.md, server-side execution
- [ ] T033 [US1] Implement the system prompt builder in `src/lib/ai/prompt.ts` combining the style's `guidance` with the current document text. The guidance must never be emitted as a message
- [ ] T034 [US1] Write `tests/unit/ai/prompt.test.ts` asserting the guidance is included in the system prompt and that it is never placed in the message array
- [ ] T035 [US1] Implement `POST /api/chat` in `src/app/api/chat/route.ts`: load content and style server-side, never from the client; stream via `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`
- [ ] T036 [US1] Build the three-panel shell in `src/app/page.tsx` with sidebar, chat, and editor regions
- [ ] T037 [US1] Implement the sidebar in `src/components/sidebar/Sidebar.tsx` with the create button (title prompt), script list, and style selector
- [ ] T038 [US1] Implement the chat panel in `src/components/chat/ChatPanel.tsx` using `useChat` with a `DefaultChatTransport`
- [ ] T039 [US1] Implement the editor in `src/components/editor/ScriptEditor.tsx` with TipTap, and wire tool parts reaching `output-available` to `applyProposal`. MUST NOT use `onToolCall`, which would apply the edit twice
- [ ] T040 [US1] Implement Markdown serialization for the editor behind a boundary in `src/lib/editor/markdown.ts` so the format can be swapped without touching components
- [ ] T041 [US1] Write `tests/contract/markdown-roundtrip.test.ts` asserting the supported Markdown subset survives document → HTML → Markdown unchanged (headings, bold, italic, lists, blockquotes, links, plain paragraphs)
- [ ] T042 [US1] Implement first-draft handling in `src/lib/domain/revision.ts`: a wholesale proposal is accepted only when the document is empty (FR-015c first case)

**Checkpoint**: User Story 1 works end to end and is independently demonstrable.

---

## Phase 4: User Story 2 — Iterate on a script through conversation (Priority: P2)

**Goal**: Targeted AI revisions that cannot destroy unrelated text, plus undo.

**Independent Test**: Generate a script, request a revision, confirm only the target region
changed; type a manual edit, then confirm the next AI request reflects it.

### Tests for User Story 2

- [ ] T043 [P] [US2] Write `tests/unit/domain/revision.test.ts` covering region resolution: anchor found once applies; anchor found twice rejects as ambiguous; `expectedText` mismatch rejects as stale; region missing entirely rejects; empty replacement over non-empty content rejects without confirmation
- [ ] T044 [P] [US2] Write `tests/integration/api/script-content.test.ts` for `PUT /api/scripts/{id}/content`: a successful save writes a revision first; `baseUpdatedAt` behind the stored value returns `409 stale_write`
- [ ] T045 [P] [US2] Write `tests/integration/api/revisions.test.ts` for listing and restoring revisions, including that a restore itself creates a new revision
- [ ] T046 [US2] Write `tests/e2e/targeted-revision.spec.ts` (Playwright) implementing quickstart.md V2 and V3: paragraphs outside the requested change are byte-identical, and a stale revision is refused

### Implementation for User Story 2

- [ ] T047 [US2] Implement region matching and application in `src/lib/domain/revision.ts`: resolve the target region, compare `expectedText`, and return either an applied result or a typed rejection reason
- [ ] T048 [US2] Implement revision persistence in `src/lib/repositories/postgres/revision-repository.ts` writing the prior content before every content change
- [ ] T049 [US2] Implement `PUT /api/scripts/{id}/content` in `src/app/api/scripts/[id]/content/route.ts` with the `baseUpdatedAt` precondition and revision-first write
- [ ] T050 [US2] Implement `GET /api/scripts/{id}/revisions` in `src/app/api/scripts/[id]/revisions/route.ts`, returning previews rather than full content
- [ ] T051 [US2] Implement `POST /api/scripts/{id}/revisions/{versionId}/restore` in `src/app/api/scripts/[id]/revisions/[versionId]/restore/route.ts`
- [ ] T052 [US2] Implement the autosave hook `src/lib/editor/use-autosave.ts`: 800 ms trailing debounce, single-flight loop re-checking a dirty flag after each save resolves, at most one in-flight request
- [ ] T053 [P] [US2] Write `tests/unit/editor/use-autosave.test.ts` with fake timers asserting: rapid edits produce one save; an edit during a save is saved after it; no two saves overlap; the final edit is always saved
- [ ] T054 [US2] Implement save-state UI in `src/components/editor/SaveIndicator.tsx` showing saved, saving, retrying, failed (FR-005)
- [ ] T055 [US2] Write `tests/unit/editor/autosave-retry.test.ts` asserting a failed save is retried exactly three times with increasing delay, that the state passes through `retrying`, that a save succeeding on the third attempt is reported as saved, and that a save failing all three is reported as failed with the text still held in the editor (FR-005a, FR-005)
- [ ] T056 [US2] Implement three automatic retries with increasing delay before reporting failure (FR-005a) in `src/lib/editor/use-autosave.ts`
- [ ] T057 [US2] Implement re-validation of the client's applied revision inside `applyProposal` in `src/stores/document-store.ts`, so a browser document that changed during the request rejects rather than overwrites
- [ ] T058 [US2] Implement `undo` in `src/components/editor/UndoControl.tsx` wired to restore the most recent revision, covering both manual and AI edits through the same path (FR-019, FR-020)
- [ ] T059 [US2] Implement distinguishable error messages for timeout, upstream failure, invalid output, and conflicting edit (FR-022a) in `src/components/chat/ErrorBanner.tsx`

**Checkpoint**: User Story 2 works and is independently demonstrable on top of US1.

---

## Phase 5: User Story 3 — Reopen a past script with its conversation (Priority: P2)

**Goal**: A library of scripts, each restoring its own text and conversation.

**Independent Test**: Create two scripts, reopen each, confirm neither's text nor
conversation bleeds into the other.

### Tests for User Story 3

- [ ] T060 [P] [US3] Write `tests/integration/api/script-messages.test.ts` asserting a conversation returns only its own script's messages in creation order
- [ ] T061 [P] [US3] Write `tests/integration/api/script-delete.test.ts` asserting deletion removes the script, its conversation, its messages, and its revisions atomically, and that a request without `confirm: true` returns `400 confirmation_required`
- [ ] T062 [US3] Write `tests/e2e/reopen-scripts.spec.ts` (Playwright) implementing quickstart.md V5: two scripts with distinct topics, reopened, no cross-contamination

### Implementation for User Story 3

- [ ] T063 [US3] Implement `GET /api/scripts/{id}` in `src/app/api/scripts/[id]/route.ts` returning the script with its content
- [ ] T064 [US3] Implement `GET /api/scripts/{id}/messages` in `src/app/api/scripts/[id]/messages/route.ts`, ordered by creation
- [ ] T065 [US3] Implement conversation restoration in `src/components/chat/ChatPanel.tsx` when a script is selected
- [ ] T066 [US3] Implement document loading in `src/stores/document-store.ts` when a script is selected, replacing state without merging it with the previous script
- [ ] T067 [US3] Implement `PATCH /api/scripts/{id}` for rename in `src/app/api/scripts/[id]/route.ts` with the same validation as creation
- [ ] T068 [US3] Implement `DELETE /api/scripts/{id}` in `src/app/api/scripts/[id]/route.ts` with a confirmation gate and transactional cascade (FR-001d)
- [ ] T069 [US3] Implement script deletion UI with confirmation in `src/components/sidebar/ScriptList.tsx`, returning to the list with nothing selected
- [ ] T070 [US3] Implement the switch-away warning when an unsaved change exists (FR-005c) in `src/components/sidebar/ScriptList.tsx`

**Checkpoint**: User Story 3 works and the workspace behaves as a library.

---

## Phase 6: User Story 4 — Assign and change a script's style (Priority: P3)

**Goal**: Exactly one predefined style shapes every AI response and stays invisible.

**Independent Test**: Generate under one style, switch, confirm the register changes, the
existing text does not, and the guidance never appears as a message.

### Tests for User Story 4

- [ ] T071 [P] [US4] Write `tests/integration/api/script-style.test.ts` asserting style assignment replaces any previous value rather than adding a second, rejects an unknown `styleId`, returns the applied style with the script, and that no endpoint can create, edit, or delete a style (FR-008, FR-009, FR-010)
- [ ] T072 [P] [US4] Write `tests/unit/ai/prompt.test.ts` addition asserting switching style mid-conversation changes subsequent system prompts without altering prior messages
- [ ] T073 [US4] Write `tests/e2e/style-switch.spec.ts` (Playwright) implementing quickstart.md V6

### Implementation for User Story 4

- [ ] T074 [US4] Implement `PUT /api/scripts/{id}/style` in `src/app/api/scripts/[id]/style/route.ts`
- [ ] T075 [US4] Wire the style selector in `src/components/sidebar/StyleSelector.tsx` to the assignment endpoint and reflect the active style
- [ ] T076 [US4] Implement the "style required" prompt in `src/components/chat/ChatPanel.tsx` when an AI request is attempted with no style assigned (spec Edge Cases)

**Checkpoint**: All four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Failure handling, security, and the remaining contract guarantees.

- [ ] T077 [P] Implement Markdown sanitization at the render boundary in `src/lib/editor/sanitize.ts` (Principle IV) and add `tests/unit/editor/sanitize.test.ts` covering script tags, event-handler attributes, and `javascript:` URLs
- [ ] T078 [P] Implement the anti-clear guard end to end in `src/lib/ai/tools.ts` using v7 `toolApproval`, with the model's `confirmedClear` always treated as false and confirmation resolved by `addToolApprovalResponse` (FR-021)
- [ ] T079 [P] Write `tests/integration/api/style-never-leaks.test.ts` asserting no response from any endpoint — scripts, messages, styles, errors — contains the style `guidance` text (FR-011)
- [ ] T080 [P] Write `tests/unit/ai/system-prompt-freshness.test.ts` asserting the system prompt for each request is rebuilt from the current document and current style, never a cached one, so a manual edit reaches the model on the next turn (FR-014, FR-018)
- [ ] T081 [P] Write `tests/unit/domain/region-only.test.ts` asserting the applied result differs from the original document only within the resolved region, including that Markdown outside it is not reflowed, reordered, or normalized (FR-015a, FR-016)
- [ ] T082 [P] Write `tests/unit/stores/single-write-path.test.ts` asserting every content mutation in `src/stores/document-store.ts` — manual keystroke and AI revision alike — passes through `applyProposal` and produces an identical persistence sequence (FR-004, FR-017)
- [ ] T083 [P] Write `tests/integration/repositories/script-isolation.test.ts` asserting content, messages, and revisions for one script are never returned for another, including after repeated create/get cycles (FR-006)
- [ ] T084 [P] Write `tests/unit/domain/title-uniqueness.test.ts` asserting the normalized-uniqueness rule covers case and surrounding whitespace, and that the per-rule rejection reasons of FR-001b are distinguishable
- [ ] T085 Write `tests/e2e/failures.spec.ts` implementing quickstart.md V4, V7, V8, plus the recovery offer end to end: force a save failure, close and reopen the workspace, confirm the local copy is offered, that restoring it puts the text back, and that declining discards it (FR-005b)
- [ ] T086 Verify the coverage floor: run `npm run test:coverage`, list every file reported below 80% with its actual percentage, and for each one add unit tests that raise it above the floor or record a justified exclusion declared in `vitest.config.mts`. The task is complete only when the coverage command exits 0 and no excluded file contains decision logic.
- [ ] T087 Update `.env.example` and `README.md` with `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and the tool-calling caveat that model support varies
- [ ] T088 [P] Write `tests/integration/api/chat-timeout.test.ts` asserting an upstream that never responds ends with a reported error within 30 seconds and leaves content unchanged (FR-023)
- [ ] T089 [P] Implement the local recovery copy for failed saves and the restore offer on next open (FR-005b), with `tests/unit/editor/recovery-copy.test.ts`
- [ ] T090 [P] Implement the 50 000-character warning before sending in `src/components/chat/ChatPanel.tsx`, without truncating the document (FR-014c)
- [ ] T091 [P] Implement streaming stop: the send control becomes a stop control, input stays editable but cannot be sent, and stopping persists no partial revision (FR-014a, FR-014b), with `tests/unit/chat/stop-streaming.test.ts`
- [ ] T092 [P] Implement the explicit full-rewrite path with confirmation in `src/lib/ai/tools.ts`, leaving the prior version recoverable (FR-015c second case, FR-015)
- [ ] T093 [P] Write `tests/unit/domain/stale-region.test.ts` asserting a revision is refused when its target region no longer holds `expectedText` at apply time, including the case where the region was deleted entirely, and that refusal leaves content untouched (FR-015b)
- [ ] T094 [P] Write `tests/unit/ai/tool-required.test.ts` asserting a request with no topic and an empty document produces no draft, and that a topic request on an empty document produces exactly one wholesale proposal (FR-012)
- [ ] T095 [P] Write `tests/unit/ai/revision-kinds.test.ts` asserting correction, expansion, reduction, and tone-change prompts each produce a revision scoped to the relevant region rather than a whole-document rewrite (FR-013, FR-015)
- [ ] T096 [P] Write `tests/integration/api/script-get.test.ts` asserting `GET /api/scripts/{id}` returns the script's own document and that an unknown id returns a distinguishable not-found error (FR-003)
- [ ] T097 [P] Write `tests/unit/domain/title-required.test.ts` asserting script creation cannot complete without a title and that no default title is ever generated (FR-001, FR-001a, FR-001c)
- [ ] T098 [P] Write `tests/integration/api/styles-readonly.test.ts` asserting the styles endpoint returns the full seeded catalogue and that no verb other than GET is handled, and that the style applied to a script is returned with the script (FR-007, FR-010)
- [ ] T099 [P] Write `tests/integration/api/error-causes.test.ts` asserting timeout, upstream failure, invalid output, and conflicting edit each map to a distinct error code and message (FR-022)

---

## Dependencies

```text
Phase 1 (Setup)
    ↓
Phase 2 (Foundational)  ← blocks every story
    ↓
    ├── US1 (P1)  ← independently shippable MVP
    │      ↓
    ├── US2 (P2)  ← needs US1's store and tool path
    │      ↓
    ├── US3 (P2)  ← needs US1's persistence; independent of US2
    │
    └── US4 (P3)  ← needs US1's prompt builder; independent of US2/US3

Phase 7 (Polish) ← after the stories it hardens
```

- **US1 is the MVP**: create, generate, see it in the editor.
- **US2 and US3 are independent of each other.** Either can be built first after US1.
- **US4 is independent of US2 and US3** but reuses US1's prompt builder.
- **Phase 7 items T077–T082** each harden a requirement that spans stories; they can be
  pulled forward if a story needs them.

## Parallel Execution Examples

**Setup**: T002, T003, T004, T005, T007, T009 are [P] — different files, no shared state.

**Foundational**: T015 and T017 are [P] against separate repository files; T020/T021 are
[P] against the AI provider.

**US1**: T022, T023, T024 are [P] — three separate test files. T028 is [P] against the
title domain module.

**US2**: T043, T044, T045 are [P] — separate test files. T053 is [P] against the autosave
hook.

**Polish**: T076, T077, T078, T079, T080, T081, T082 are all [P] — separate modules.

## Implementation Strategy

### MVP first

1. Phase 1 → Phase 2 → Phase 3 (US1). Stop there and validate: a user can create a named
   script and get a first draft in the editor.
2. That checkpoint is the product's core loop and proves the riskiest assumption (the model
   can produce a valid tool call through OpenRouter).

### Incremental delivery

3. US2 next, because targeted edits are what make the tool useful beyond a first draft. The
   region-matching tests (T043) are the highest-value tests in the feature.
4. US3 makes it a library; US4 adds tone control.
5. Phase 7 hardens; do not defer T077 (anti-clear) or T081 (stop semantics) past their
   stories, since both protect persisted user work.

### Test-first ordering

Every implementation task has its test task immediately preceding it in the same phase.
Where a test is marked [P], it can be written in parallel with other tests, but never after
the implementation it covers.
