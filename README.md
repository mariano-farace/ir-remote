# Narrative Engine

A three-panel workspace for drafting documentary scripts with an AI assistant: the
sidebar lists your scripts, the centre panel is the conversation, and the right panel is
a live Markdown editor. The AI writes and revises the script in the editor itself, not as
chat text to copy by hand.

## Requirements

- Node.js 22 (minimum 22.12) and npm 10
- Docker, for the local PostgreSQL container and the integration tests
- An OpenRouter API key

## Configuration

`.env.example` lists the variables and is committed; `.env` is not. Either copy it to
`.env`, or export the variables in your shell.

| Variable              | Required | Purpose                                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`  | yes      | Authenticates requests to OpenRouter. Server-side only.                                                  |
| `OPENROUTER_MODEL`    | yes      | The OpenRouter model slug every AI request uses, e.g. `anthropic/claude-sonnet-4.5`.                     |
| `OPENROUTER_BASE_URL` | no       | OpenRouter's API address; defaults to `https://openrouter.ai/api/v1`. Only the end-to-end suite sets it. |
| `DATABASE_URL`        | yes      | PostgreSQL connection string. The default matches the `postgres` service in `docker-compose.yml`.        |

The app refuses to start if `OPENROUTER_API_KEY` or `OPENROUTER_MODEL` is missing, and
the error names the missing variable. The model is configuration, so switching models is
a change to `OPENROUTER_MODEL`, not to code.

> **Tool calling: model support varies.** The workspace edits the script through a
> tool call, so the model must support tool calling on OpenRouter. A model that cannot
> produce a valid tool call cannot write the script: the workspace reports an error
> instead of writing a partial or corrupted document. Check a slug's tool-calling
> support before using it.

## Run it

```bash
npm install
npm run dev                    # http://localhost:3000
```

The migration and seed can be applied to a database you already have; they run `psql`
with `DATABASE_URL` from your shell, which `.env` alone does not set:

```bash
export DATABASE_URL=postgres://narrative:narrative@localhost:5432/narrative_engine
npm run db:migrate
npm run db:seed
```

## Checks

```bash
npm run typecheck
npm run lint
npm run test          # unit, integration (real PostgreSQL via Testcontainers), contract
npm run test:coverage # fails below the 80% per-module floor
npm run test:e2e      # Playwright critical flows; requires the configuration above
```

## How it works

The active script's text and conversation live in a Zustand store, the single source of
truth. The user typing and the AI's tool call both go through the same
`applyProposal` transition. An AI change is a _region-addressed revision_: it names the
text it expects to find and is applied only if that text is still there, so it cannot
overwrite an unrelated part of the script or a newer edit. Every content change is saved
automatically and the previous version is kept, so any change can be undone.

The governing rules are in `.specify/memory/constitution.md`; the feature's
specification, plan, and contracts are in `specs/001-script-workspace/`.
