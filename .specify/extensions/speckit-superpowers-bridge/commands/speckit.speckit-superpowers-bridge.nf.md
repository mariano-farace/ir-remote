---
description: "Execute exactly one phase of Spec Kit tasks through the Superpowers bridge, then stop"
---

# Bridge Next-Phase (nf)

Execute exactly one phase of the active Spec Kit feature through Superpowers,
then stop and return control to the human. Unlike the bridge `.execute` command,
this command never runs every pending task in a single pass.

## Behavior

1. Read `.specify/superpowers-handoff.json`; if it is missing or stale, create a
   ready handoff with the platform-selected `update-handoff` script. If the
   handoff is already `complete`, stop and tell the user there is nothing to do.
2. Read `.specify/memory/constitution.md`, `spec.md`, `plan.md`, and `tasks.md`
   before touching implementation files.
3. Select the phase to execute with the algorithm in "Phase selection" below.
   If no phase has pending tasks and the handoff is not `complete`, switch to the
   full closing mode (see "Closing mode").
4. Run the bridge guard for `superpowers.executing-plans`.
5. Derive a disposable Superpowers adapter scoped to the selected phase only,
   and execute that adapter with Superpowers implementation discipline: TDD
   before each code-modifying task and systematic debugging on any failure.

   **Execute the phase's tasks in file order** — top to bottom as they appear
   in `tasks.md`. Take the first unchecked task in the phase, finish it, then
   move to the next one down. Do not sort by ID, do not reorder by perceived
   dependency, do not batch several tasks together, and do not start a later
   task while an earlier one is still open. The file order is the intended
   build order: when a task was moved to sit after the one it depends on, its
   ID no longer matches its position, and that is deliberate.

   **Check off each task the moment it passes**, before starting the next one.
   A task passes only when its own verification succeeds (for test tasks: the
   test exists and runs; for implementation tasks: its tests are green). Never
   defer the checkboxes to the end of the phase, and never check a task whose
   verification has not run. If a task cannot be completed, stop there and
   leave it unchecked rather than continuing past it.

6. Leave the handoff in `executing` and stop. If the Spec Kit contract is wrong
   or incomplete, stop and set handoff status to `blocked`.

## Execution

Use the extension command id from either agent:

- Codex: `$speckit-speckit-superpowers-bridge-nf`
- Claude Code: `/speckit-speckit-superpowers-bridge-nf`

Before implementation begins, run the platform flavor selected by
`.specify/init-options.json.script`. This project uses `sh`.

```bash
bash .specify/extensions/speckit-superpowers-bridge/scripts/bash/update-handoff.sh --status executing --actor <codex|claude>
bash .specify/extensions/speckit-superpowers-bridge/scripts/bash/guard-command.sh --action "superpowers:executing-plans" --actor <codex|claude>
```

Do not invoke Superpowers `brainstorming` or `writing-plans` for this active
feature. Spec Kit artifacts are the only design and execution contract.

## Phase selection

`tasks.md` remains the only requirements and completion contract. A phase starts
at a line matching `^##[[:space:]]+Phase[[:space:]]+[0-9]+` and ends at the next
`^##[[:space:]]` heading (any level-2 heading — `## Notes`, `## Dependencies &
Execution Order`, `## Parallel Example: Phase 2` are NOT phases) or at EOF. Task
lines match `^- \[[ xX]\] T[0-9]+[a-z]?` (IDs may carry an alphabetic suffix such
as `T020b`, and checked boxes may be `[x]` or `[X]`).

Resolve the feature directory from `.specify/superpowers-handoff.json`
(`.feature_directory`), falling back to `.specify/feature.json`. Then run:

```bash
TASKS_PATH="<feature_directory>/tasks.md"
awk '
function flush_phase() {
    if (cur_phase_num > 0) {
        printf "PHASE\t%d\t%d\t%s\n", cur_phase_num, cur_pending, cur_title
        n_phases++
        if (cur_pending > 0 && first_pending == 0) first_pending = cur_phase_num
    }
}
BEGIN { cur_phase_num=0; cur_pending=0; n_phases=0; first_pending=0; in_fence=0 }
/^[[:space:]]*(```|~~~)/ { in_fence = !in_fence; next }
/^##[[:space:]]+Phase[[:space:]]+[0-9]+/ {
    if (in_fence) next
    flush_phase(); cur_title=$0
    match($0, /Phase[[:space:]]+[0-9]+/)
    cur_phase_num=substr($0, RSTART+6, RLENGTH-6)+0; cur_pending=0
    next
}
/^##[[:space:]]/ {
    if (in_fence) next
    flush_phase(); cur_phase_num=0; cur_pending=0; cur_title=""
    next
}
cur_phase_num > 0 && !in_fence && /^- \[[ xX]\] T[0-9]+[a-z]?/ {
    if ($0 ~ /^- \[ \]/) cur_pending++
}
END {
    flush_phase()
    printf "META\t%d\t%d\t%d\n", n_phases, first_pending, first_pending
}
' "$TASKS_PATH"
```

Read the `META <n_phases> <first_pending> <selected>` line:

- `n_phases == 0` → no phased `tasks.md`; stop and report (see Boundaries).
- `first_pending == 0` → no pending tasks; go to "Closing mode".
- otherwise → execute phase `first_pending`.

The selected phase is always the first with pending tasks. This protects Phases 1
and 2 implicitly: while either has pending tasks it *is* the first pending phase,
so a later user-story phase can never be selected ahead of it. Between user-story
phases (3+) there is no such block — Spec Kit contract makes them independent.

## One phase then stop

Execute ONLY the selected phase. Fence the adapter strictly to the task IDs that
fall inside that phase's line range. When every task in the phase is checked:

- Do NOT run `superpowers:verification-before-completion`.
- Do NOT run `superpowers:requesting-code-review`.
- Do NOT run `superpowers:finishing-a-development-branch`.
- Do NOT change the handoff status away from `executing`.
- Stop and report which phase ran, which tasks were checked, and that the next
  phase is awaiting a fresh invocation.

## Extension hooks (before_implement / after_implement)

This command replaces `speckit.implement` for the selected phase, so it MUST
fire the same `before_implement` hook that `speckit.implement` would fire. It
fires `after_implement` only in closing mode (when no tasks remain).

### Before implementation (`before_implement`)

Fire BEFORE transitioning the handoff to `executing`:

1. Check `.specify/extensions.yml`. If it does not exist, or has no
   `hooks.before_implement`, skip silently. If it is malformed, report the parser
   error and state that no hooks were checked, including mandatory hooks, then
   continue the core lifecycle normally.
2. For each hook under `hooks.before_implement`:
   - **Skip any hook whose `extension` is `speckit-superpowers-bridge`.** The
     bridge's own `before_implement` hook is its guard; firing it from the bridge
     would block the bridge itself.
   - Skip hooks where `enabled` is explicitly `false`.
   - Skip hooks with a non-empty `condition`.
3. Fire each remaining hook via its `command`, rendered per agent
   (`speckit.git.commit` → `/speckit-git-commit` or `$speckit-git-commit`).
   Mandatory hooks (`optional: false`) run and block; optional hooks
   (`optional: true`) run only after surfacing their prompt and getting user
   confirmation.

### After implementation (`after_implement`)

Only in closing mode. Dispatch `after_implement` before transitioning the
handoff to `complete`, applying the same filters (including the
`speckit-superpowers-bridge` skip). If a mandatory `after_implement` hook fails,
do not transition to `complete`.

### Hook invocation contract

For every mandatory hook, emit Spec Kit's phase-appropriate automatic-hook block
before invocation:

```text
## Extension Hooks

**Automatic Pre-Hook**: <extension>   # before_implement
**Automatic Hook**: <extension>       # after_implement
Executing: `/<dotted-command-id>`
EXECUTE_COMMAND: <dotted-command-id>
```

Emit only the phase-appropriate label, not both in one live block. Actually
invoke the rendered agent command and wait for its result; printing the directive
is not success.

## Superpowers adapter contract (one phase)

Spec Kit `tasks.md` remains the only requirements and completion contract.
Because Superpowers' `task-brief` extractor requires headings that match
`### Task N`, create a deterministic disposable adapter outside the native
`.superpowers/sdd/` workspace (for example, under the OS temporary directory
using a stable repository/feature/phase-derived name reused on resume). Include
pointers to the active `spec.md`, `plan.md`, constitution, and global
constraints, plus the selected phase heading.

For every unchecked non-deferred `- [ ] T###` line **inside the selected phase
only**, emit one `### Task N: T###` heading followed by the exact canonical
checkbox line and its file paths. Do NOT include tasks from other phases, already
checked tasks, or deferred tasks. Invoke `superpowers:executing-plans` with the
adapter, and after each native task passes, mark the corresponding canonical
checkbox in `tasks.md`. Remove the adapter with cleanup on success or failure;
the native `.superpowers/sdd/` workspace remains Superpowers-owned scratch.

Malformed `.specify/extensions.yml` must be reported with the parser error and an
explicit statement that no hooks, including mandatory hooks, were checked;
continue the core lifecycle normally. A missing registry is skipped.

## Required Superpowers discipline

Inside the selected phase:

- `superpowers:test-driven-development` before each code-modifying task.
- `superpowers:systematic-debugging` before fixing any failure or unexpected
  behavior.

Deferred to closing mode (never mid-phase):

- `superpowers:verification-before-completion`
- `superpowers:requesting-code-review`
- `superpowers:finishing-a-development-branch`

For delegated implementation prompts, include:

- `.specify/memory/constitution.md`
- `<feature_directory>/spec.md`
- `<feature_directory>/plan.md`
- `<feature_directory>/tasks.md`
- Denylist: `speckit.implement`, `superpowers:brainstorming`,
  `superpowers:writing-plans`

## Closing mode

If the phase-selection awk reports `first_pending == 0` (no pending tasks) and
the handoff is not already `complete`, run the full close instead of a phase:

1. `superpowers:verification-before-completion` with fresh passing evidence.
2. `superpowers:requesting-code-review`.
3. Dispatch `after_implement` (see above).
4. `superpowers:finishing-a-development-branch`.
5. Set the handoff to `complete`:

```bash
bash .specify/extensions/speckit-superpowers-bridge/scripts/bash/update-handoff.sh --status complete --actor <codex|claude>
```

If the handoff is already `complete`, do nothing and tell the user there is
nothing to close (avoids re-archiving a closed feature).

## Handoff writes

The bridge's only state is `.specify/superpowers-handoff.json`. Between phases,
keep the status `executing`: it denies `speckit.implement` and
`speckit.constitution`, preserves the `artifacts_sha256` drift snapshot, and
makes `bridge-status` recommend "continue". Use `complete` only in closing mode,
and `blocked` only when the Spec Kit contract is missing or wrong:

```bash
bash .specify/extensions/speckit-superpowers-bridge/scripts/bash/update-handoff.sh --status blocked --reason "Describe the Spec Kit artifact gap" --actor <codex|claude>
```

## Boundaries

- No `scripts/powershell/` flavor is provided; this command is bash-only.
- Never runs `speckit.implement`.
- Never runs more than one phase per invocation.
- Never silently skips a phase with pending tasks.
- Never marks the handoff `complete` while any non-deferred task is unchecked.
- A `tasks.md` without `## Phase N` headings is out of scope: stop and tell the
  user to use `/speckit-superpowers-bridge` (the full executor) instead.
