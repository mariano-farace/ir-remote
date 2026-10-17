# Implementation Plan: Script Workspace

**Branch**: `001-script-workspace` | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-script-workspace/spec.md`

## Summary

A three-panel web workspace for drafting documentary scripts with an AI assistant. The
left panel lists scripts and the style selector; the centre panel is the conversation; the
right panel is a live Markdown editor. The defining requirement is **one authoritative
document**: both the AI's tool calls and the user's typing flow through a single state
transition path, edits are region-addressed so an AI revision cannot destroy unrelated
text, and every version is recoverable.

Technical approach: a Next.js App Router application. The client holds the active document
in Zustand; the model's tool call is executed server-side and arrives as a *region-addressed
proposal* carrying the expected prior text of its target region, applied only if that region
still matches. The model is reached through OpenRouter, so the model itself is runtime
configuration rather than a code dependency. Saves are debounced through a repository
interface backed by PostgreSQL, which also stores revisions, conversations, and the static
style catalogue.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS (local: 22.21.1, which satisfies
Vitest 5's `^22.12` floor)

**Primary Dependencies**: Next.js 16.4.2 (App Router), React 19.3.1, Tailwind CSS,
Vercel AI SDK (`ai` 7.0.143 + `@ai-sdk/react` 4.0.147) via
`@openrouter/ai-sdk-provider` 3.1.0, TipTap 3.32.0, Zustand 5, Zod, Vitest 5.0.5 with
`@vitest/coverage-v8`, Playwright 1.64.1

**Storage**: PostgreSQL 14+ (local via Docker; `pg` 8.x driver with a `globalThis`-cached
pool behind a repository layer)

**Testing**: Vitest 5 split into a `unit` project (jsdom) and a `server` project (node);
integration tests run against a real PostgreSQL started by Testcontainers, not a mock;
Playwright for end-to-end critical flows and for async Server Components, which Vitest
cannot render

**Target Platform**: Web browser, desktop-first three-column layout; server route handlers
run on Node.js

**Project Type**: Web application, single Next.js project (frontend and server route
handlers colocated)

**Performance Goals**: Editor keystroke to rendered text under 100 ms; a chat prompt's
first streamed token visible within 2 s; sidebar list of 200 scripts renders within 500 ms

**Constraints**: Autosave debounced at 800 ms with an in-flight save at most one at a
time; every AI request bounded by a 60 s timeout; script size supported up to 50 000
characters before the user is warned that context is at risk

**Scale/Scope**: Single user, single workspace, up to a few hundred scripts; no
concurrency, no accounts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | How this plan satisfies it |
|---|---|---|
| I. Test-First | Every behavior preceded by a failing test | Tasks are ordered test-first; each task names the test that precedes it |
| II. Coverage Above 80% | Per-module coverage floor | Vitest coverage configured per-directory thresholds in `vitest.config.ts`; CI gate |
| III. Single Source of Truth | One write path into the document | `documentStore.applyProposal()` is the only mutator; editor input and AI tool calls both call it |
| III. Recoverability | Revisions retained; undo across both paths; anti-clear guard | `script_revisions` table; `applyProposal` refuses an empty replacement over a non-empty document without confirmation |
| IV. LLM Output Is Untrusted | Schema validation before state mutation | Zod schema validates the tool call payload before `applyProposal` is reachable; Markdown renders through sanitising path |
| IV. Secrets | Key server-side only | Provider call happens in a route handler reading `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, both validated at boot |
| V. English | All artifacts English | Applies to this plan, all code, and all UI copy |
| Technology Stack | No unapproved substitution | Stack matches the constitution's section exactly |
| MVP Scope | No scope growth | Deletion, accounts, and user-authored styles remain out of scope |

**Result**: PASS. No unjustified violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-script-workspace/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── tool-call.md
│   └── http-api.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                     # three-panel workspace shell
│   └── api/
│       ├── scripts/
│       │   ├── route.ts             # GET list, POST create
│       │   └── [id]/
│       │       ├── route.ts         # GET one script, PATCH title
│       │       ├── content/route.ts # PUT document text (autosave)
│       │       ├── messages/route.ts# GET conversation
│       │       └── style/route.ts   # PUT style assignment
│       ├── chat/route.ts            # POST streaming chat + tool call
│       └── styles/route.ts          # GET static style catalogue
├── components/
│   ├── sidebar/                     # script list, new-script button, style selector
│   ├── chat/                        # message list, prompt input
│   └── editor/                      # TipTap editor, save indicator, undo affordance
├── lib/
│   ├── domain/
│   │   ├── script.ts                # domain types and invariants
│   │   ├── revision.ts              # region matching and apply logic
│   │   └── style.ts                 # style catalogue type
│   ├── repositories/
│   │   ├── types.ts                 # repository interfaces
│   │   └── postgres/                # Postgres implementations
│   ├── ai/
│   │   ├── prompt.ts                # system prompt construction from a style
│   │   └── tools.ts                 # tool definitions + Zod schemas
│   └── validation/
├── stores/
│   └── document-store.ts            # Zustand store: the single source of truth
└── env.ts                           # startup validation of required secrets

tests/
├── unit/                            # domain logic, store, prompt builders
├── integration/                     # route handlers against real PostgreSQL
├── contract/                        # tool-call schema and HTTP API contracts
└── e2e/                             # Playwright critical flows

db/
├── migrations/                      # SQL migrations, checked in
└── seed/                            # static style catalogue seed
```

**Structure Decision**: Single Next.js project. The client and the route handlers share the
same repository interface, so the domain layer has no knowledge of HTTP or React. Domain
logic (`src/lib/domain`, `src/stores`) is pure TypeScript with no framework imports, which
is what makes the 80% per-module floor achievable without testing React internals.

The split that matters for the constitution is:
- `src/lib/domain` and `src/stores` — pure, unit-testable, governed by Principle III.
- `src/lib/repositories` — the swap boundary mandated by MVP Scope Boundaries; tested
  against a real database.
- `src/lib/ai` — the untrusted boundary governed by Principle IV; its tool schema is the
  contract that keeps model output out of state until validated.

## Complexity Tracking

> No violations. This section is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | | |
