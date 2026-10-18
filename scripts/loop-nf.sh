#!/usr/bin/env bash
# Run /speckit-speckit-superpowers-bridge-nf repeatedly, one phase per session,
# until every task in the feature's tasks.md is checked off.
#
# Each iteration spawns a fresh `claude -p` process, so the phase executes with
# an empty context window. The loop stops when tasks.md is fully checked, or
# aborts when an iteration leaves the pending count unchanged.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Colours, disabled when the output is not a terminal (logs, pipes).
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'
  DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; RED=""; YELLOW=""; DIM=""; RESET=""
fi

# The active feature's tasks.md, resolved from Spec Kit's feature pointer.
FEATURE_DIR="$(jq -r '.feature_directory // empty' .specify/feature.json 2>/dev/null || true)"
if [ -z "$FEATURE_DIR" ]; then
  echo "No active feature in .specify/feature.json. Run /speckit-specify first." >&2
  exit 1
fi

TASKS="$FEATURE_DIR/tasks.md"
if [ ! -f "$TASKS" ]; then
  echo "Missing task list: $TASKS. Run /speckit-tasks first." >&2
  exit 1
fi

MAX_PHASES="${MAX_PHASES:-0}"

pending() {
  grep -c '^- \[ \] T' "$TASKS" || true
}

iterations=0

while true; do
  antes=$(pending)

  if [ "$antes" -eq 0 ]; then
    echo "${GREEN}All tasks complete.${RESET}"
    break
  fi

  if [ "$MAX_PHASES" -gt 0 ] && [ "$iterations" -ge "$MAX_PHASES" ]; then
    echo "${YELLOW}Reached MAX_PHASES=$MAX_PHASES. Stopping with $antes task(s) pending.${RESET}"
    break
  fi

  iterations=$((iterations + 1))

  echo ""
  if [ "$MAX_PHASES" -gt 0 ]; then
    echo "${BOLD}=== Iteration $iterations/$MAX_PHASES · $antes task(s) pending ===${RESET}"
  else
    echo "${BOLD}=== Iteration $iterations · $antes task(s) pending ===${RESET}"
  fi

  # Route through Claude Code Router so the headless session picks up the
  # provider config that the interactive shell loads via the `claude-or` alias.
  # Stream JSON so the phase is watchable while it runs, and reduce it to a
  # one-line-per-event trace instead of the full raw payload.
  # `set -o pipefail` would abort the whole loop the moment `ccr code` exits
  # non-zero, which happens routinely (the headless session reports failures
  # through its exit status). Capture the status instead of dying on it: the
  # task-count check below is the real signal for whether the phase worked.
  phase_status=0
  ccr code -p "/speckit-speckit-superpowers-bridge-nf" --permission-mode auto \
    --output-format stream-json --verbose \
  | jq -r --unbuffered '
      if .type == "assistant" then
        .message.content[]? |
          if .type == "text" then "  \(.text)"
          elif .type == "tool_use" then "  → \(.name): \(.input | tostring | .[0:160])"
          else empty end
      elif .type == "result" then
        if .subtype == "success" then "  \("\u001b[32m")[done: success]\($reset)"
        else "  \("\u001b[31m")[done: \(.subtype)]\($reset)" end
      else empty end' --arg reset "$RESET" || phase_status=$?

  despues=$(pending)

  if [ "$despues" -ge "$antes" ]; then
    echo "${RED}Phase did not check off any task ($antes -> $despues, exit $phase_status). Aborting.${RESET}" >&2
    exit 1
  fi

  echo "${GREEN}Phase done: $antes -> $despues pending (exit $phase_status).${RESET}"
done
