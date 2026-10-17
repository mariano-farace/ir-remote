
# Narrative Engine Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

Every unit of production behavior MUST be preceded by an automated test that fails for
the right reason.

- The cycle is mandatory and strictly ordered: write the test → run it and observe it
  fail → write the minimal implementation → run it and observe it pass → refactor.
- A test never observed failing does not count as a test. A commit that adds production
  behavior without a corresponding test in the same or a preceding commit MUST be
  rejected.
- Tests describe behavior through public interfaces, not private implementation. A test
  that breaks only because an internal function was renamed MUST be rewritten, not kept.
- Tests MUST be deterministic and isolated: no shared mutable state between tests, no
  reliance on wall-clock time, no real network calls, no dependency on test ordering.
- A defect fix starts with a failing regression test that reproduces the defect. Fixing
  the bug first and adding the test afterwards is a violation.

**Rationale**: This product's core risk is a system that appears to work — the editor
shows text, the chat responds — while document state silently diverges from what the
user sees. Post-hoc tests validate what was built, not what was required, and cannot
catch a confidently wrong implementation.

### II. Coverage Above 80%

Automated test coverage MUST exceed 80% for the codebase as a whole, and each module
holding decision logic MUST itself exceed 80%.

- The floor is a gate, not a target. A change that pulls a module below the floor MUST
  be blocked before merge, regardless of the overall figure.
- Coverage counts only assertions capable of failing. Framework boilerplate, generated
  code, and type-only files MAY be excluded, and every exclusion MUST be declared
  explicitly in the coverage configuration rather than left implicit.
- Unit, integration, and end-to-end coverage count together. A module exercised only by
  a slow end-to-end test still requires unit coverage of its branches.
- Coverage never substitutes for correctness. Reviewers MUST read the assertions, not
  only the coverage report.

**Rationale**: Required by the project owner. It is a floor rather than a target because
coverage is a cheap objective proxy for untested branches; it is explicitly subordinate
to assertion quality because the proxy is trivial to game.

### III. Single Source of Truth for Document State

The document exists in exactly one authoritative place, and every panel renders from it.

- The active script's text and its chat history MUST live in the application state
  store as the single source of truth. The editor is a view over that state, never a
  second copy of it.
- LLM tool calls that write the document and manual edits typed by the user MUST both
  flow through the same state transition path. Two write paths into the same document
  is a defect.
- Because edits are bidirectional (the LLM writes, the user types), every write MUST be
  reconciled against the current document version. A tool call computed against a stale
  snapshot MUST NOT silently overwrite newer user edits; it MUST either re-base onto the
  current text or surface a conflict to the user.
- Autosave MUST be explicit about its state: the UI MUST show whether the document is
  saved, pending, or failed. A failed save is never silent.
- The LLM MUST receive the current document content as context before proposing
  changes, so that its edits are made against what the user actually has.

**Recoverability.** Autosave makes every write durable, so a bad write is permanent
unless recovery is designed in. This is a hard requirement, not a nice-to-have:

- Every persisted version of a document MUST be retained as a revision. Before a
  revision is pruned, the user MUST be able to restore any recent one. A write that
  cannot be undone is a defect.
- A tool call that replaces or removes more than a trivial portion of the document
  (a wholesale rewrite rather than a targeted edit) MUST be treated as destructive: the
  user MUST be able to undo it in one action from the editor, and the pre-write revision
  MUST be captured before the change is applied.
- Undo MUST cover both write paths. A manual edit and an LLM edit MUST both be
  undoable through the same mechanism; neither path may bypass the history.
- An empty or whitespace-only result MUST NOT be written over a non-empty document
  without an explicit user confirmation.

**Rationale**: The defining hazard of this architecture is state divergence between the
chat panel, the editor panel, and the LLM's view of the document. Two write paths into
one document with no reconciliation is the most likely source of silently lost user work.
Because autosave persists immediately, reconciliation alone is not enough: without
history, a single bad tool call destroys work that no user action can recover.

### IV. LLM Output Is Untrusted Input

Model output is treated exactly like input from an untrusted third party.

- Streamed and tool-called LLM output MUST be validated against a schema before it is
  allowed to mutate document state. A malformed tool call MUST be rejected with an error
  surfaced to the user, never coerced into a partial write.
- Model output MUST NOT be rendered as raw HTML. Markdown renders through a sanitizing
  path; injected scripts, event handlers, and unsafe URLs MUST be stripped.
- The style (skill) system prompt is configuration owned by the application. Its content
  MUST NOT be taken from user input or from model output.
- Every LLM call MUST have a bounded timeout and a bounded retry policy. An upstream
  failure MUST degrade to a visible error state, never to a hang or a silently empty
  document.
- API keys MUST be read from server-side environment configuration and MUST NOT reach
  the browser. No key, token, or secret is committed to the repository.

**Rationale**: An LLM-driven editor is a text injection surface that writes directly to
the user's document. Treating model output as trusted would let a malformed or hostile
response corrupt saved work or execute in the user's session.

### V. English as the Project Language

English is the language of the codebase.

- All artifacts MUST be written in English: identifiers, code comments, commit messages,
  documentation, specifications, plans, task lists, test names, user-facing UI copy, and
  LLM system prompts.
- Non-English text MAY appear only as literal product content — for example, a user's
  own script draft written in another language. Narrative content in a script is data,
  not a codebase artifact, and is exempt.
- A change introducing non-English identifiers, comments, or documentation MUST be
  corrected in review before merge.

**Rationale**: Required by the project owner. A single language for code and governing
documents removes a translation step from every review and keeps prompts, UI copy, and
tests matching one vocabulary.

## Technology Stack

The stack below is a binding commitment. Substituting a listed technology or adding a
second one serving the same role MUST be proposed as a constitution amendment, not
introduced silently in a feature branch.

- **Application framework**: Next.js (React), with Tailwind CSS for layout, including
  the three-column workspace.
- **LLM transport and client state**: the Vercel AI SDK (`useChat`, `streamObject`, and
  tool calling). Streaming and tool calling MUST go through this SDK rather than a
  hand-rolled fetch/SSE layer.
- **Model provider**: DeepSeek API (`deepseek-chat`).
- **Rich text / Markdown editor** (right panel): TipTap.
- **Global state store**: Zustand. It holds the active document text and is the single
  source of truth required by Principle III.
- **Database**: PostgreSQL. Chat histories, script records, and the static style list
  persist here. The schema is owned as SQL migrations checked into the repository.
- **Test runner**: Vitest, with coverage enforcement configured in the same toolchain.
  The 80% floor in Principle II is automated through it.

Data access MUST sit behind an interface as stated in MVP Scope Boundaries, so the
PostgreSQL implementation stays swappable without touching domain logic.

## MVP Scope Boundaries

Scope discipline is a hard constraint, not a preference. The MVP MUST NOT grow beyond
the following, and any proposal to add one of the listed exclusions requires a
constitution amendment first.

- **In scope**: a three-panel workspace; creating and listing Markdown scripts;
  selecting exactly one pre-existing style per script; chat-driven generation and
  revision of the script; bidirectional synchronization between chat and editor; and
  autosave.
- **Out of scope for the MVP**: user-authored styles; more than one style per script;
  multiuser collaboration, sharing, or accounts; real-time concurrent editing; export
  formats beyond Markdown; and any model provider other than the one configured.
- Persistence of chat histories, script records, and the static style list is required;
  changing the storage backend later MUST NOT require rewriting domain logic, so data
  access MUST sit behind an interface.
- The style list is static configuration for the MVP. It MUST NOT become a
  user-editable table through an undocumented feature path.

## Development Workflow & Quality Gates

No change reaches the default branch without passing every gate below.

- **Sequence**: specification → plan → tasks → implementation. Implementation of
  behavior that has no written specification and no failing test MUST NOT begin.
- **Gates** (all blocking):
  1. The full test suite passes locally and in CI.
  2. Coverage exceeds the floor defined in Principle II.
  3. No new untested branch and no new silent error path is introduced.
  4. No document write bypasses the single state transition path (Principle III).
  5. No LLM output reaches state or the DOM without validation (Principle IV).
  6. No non-English artifact is introduced (Principle V).
- **Review**: Every change receives review that explicitly names the governed principles
  it touches and how it satisfies them. A reviewer who identifies a violation MUST block
  the merge.
- **Red-before-green evidence**: A pull request adding behavior MUST show, in its
  description or commit history, the failing test that preceded the implementation.
- **Commit hygiene**: Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `test`,
  `chore`, `perf`, `ci`), with a body that explains intent rather than restating the diff.
- **Complexity justification**: Any deviation from these gates MUST be documented in the
  pull request and approved by a reviewer. It MUST NOT be waived silently.

## Security, Secrets & Cost Control

- Secrets MUST come from server-side environment configuration and MUST be validated at
  startup. A missing required secret MUST fail fast at boot, not at first request.
- All external input MUST be validated at the boundary before processing: chat prompts,
  uploaded or opened files, and LLM responses alike.
- Logs and error messages MUST NOT expose API keys, full prompt contents containing user
  drafts, or internal paths.
- Every LLM invocation MUST be attributable to a script and a session, so that token
  spend can be audited and bounded. Unbounded or unattributed model calls MUST NOT be
  introduced.
- Dependencies MUST be pinned and their licenses recorded. Introducing a dependency
  whose license conflicts with the project's distribution model MUST be blocked.

## Governance

This constitution supersedes all other development practices. Where a habit, a
convention, or an external guide conflicts with a principle stated here, this document
wins.

- **Amendment procedure**: An amendment is proposed as a change to this file with a
  written rationale and explicit approval from the project maintainer before merge. The
  change MUST update the Sync Impact Report, the version line, and the Last Amended date
  in the same commit.
- **Versioning policy**: Semantic versioning applies.
  - MAJOR: a principle is removed, redefined, or relaxed in a way that invalidates
    previously compliant work.
  - MINOR: a principle or section is added, or existing guidance is materially expanded.
  - PATCH: clarifications, wording, and typo fixes with no change in obligation.
- **Compliance review**: Every pull request verifies compliance and cites the principles
  it touches. A repeatable decision left to reviewer judgment SHOULD be migrated into
  this document so that it stops being a matter of opinion.
- **Runtime guidance**: Day-to-day implementation guidance lives in the specification
  and plan artifacts for each feature; this document governs, those documents elaborate.

**Version**: 1.2.0 | **Ratified**: 2026-10-17 | **Last Amended**: 2026-10-17
