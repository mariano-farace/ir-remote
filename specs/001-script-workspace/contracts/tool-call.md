# Contract: AI Tool Call (`apply_document_revision`)

**Feature**: `001-script-workspace` | **Date**: 2026-10-17

This is the boundary governed by constitution Principle IV: model output is untrusted input.
Nothing in this payload reaches document state until it validates against this contract.

## Tool Definition

Exactly one tool is exposed to the model.

**Name**: `apply_document_revision`

**Description given to the model**: Apply a change to the documentary script. You MUST
identify the exact text you are replacing and quote it verbatim in `expectedText`.
Text you do not include in `targetRegion` will not be touched, so supply only the change
you were asked for. For the very first draft of an empty document, set
`isWholesaleDraft` to true and leave `expectedText` empty.

### Input schema

| Field | Type | Required | Validation |
|---|---|---|---|
| `targetRegion` | object | yes | Must contain exactly one of: `wholeDocument: true`, or `anchorText` (a verbatim quote of at least 20 characters, unique in the document) |
| `expectedText` | string | yes | Must be empty when `isWholesaleDraft` is true; otherwise MUST be a verbatim substring of the current document |
| `replacementText` | string | yes | The new text. May be empty only with `confirmedClear: true` |
| `isWholesaleDraft` | boolean | no | Defaults false. Valid only when the current document is empty |
| `confirmedClear` | boolean | no | Defaults false. Only the user may set this, never the model (see below) |
| `summary` | string | yes | One sentence describing the change, shown in the chat. Max 200 characters |

### Rejection rules (all must surface an error to the user, none may mutate state)

1. **Schema failure** — payload does not match the schema. Reject with a validation error.
2. **Region not unique** — `anchorText` occurs zero times or more than once. Reject: the
   model's target is ambiguous.
3. **Stale region** — `expectedText` does not match the document at `targetRegion` at apply
   time (FR-015b). Reject with "the document changed while the request was in progress".
4. **Wholesale draft on a non-empty document** — `isWholesaleDraft: true` while content
   exists (FR-015c). Reject.
5. **Empty replacement over non-empty document** — `replacementText` empty and
   `confirmedClear` false (FR-021). Reject and ask the user to confirm.

`confirmedClear` deserves emphasis: the model MUST NOT be trusted to assert the user
authorised clearing the document. The server MUST treat any `confirmedClear: true` arriving
from the model as `false` and require the confirmation to come from a separate,
user-initiated act.

**Mechanism**: this is implemented with AI SDK v7's server-side `toolApproval` (the
replacement for `needsApproval`), resolved by the client through `addToolApprovalResponse`.
When the tool detects the destructive case, it returns approval-required rather than
applying; the client shows a confirmation and only a user response completes the call. No
custom confirm round-trip is introduced unless `toolApproval` proves unworkable for a
single tool.

## Why Region-Addressed

The clarification of 2026-10-17 requires that AI revisions cannot destroy unrelated text
by construction. A model returning a whole document cannot offer that guarantee: it may
paraphrase an untouched paragraph, drop a line, or reflow formatting. A model naming a
region and quoting the text it expects can be checked mechanically, and the check fails
closed.

## Server-side Handling Sequence

1. Receive the tool call from the stream.
2. Validate against the schema. On failure, emit an error event; do not stream a tool result.
3. Resolve `targetRegion` against the current document (fetched server-side, not taken
   from the client) and compare `expectedText`. On mismatch, emit a stale-conflict event.
4. If valid, the server tool `execute` returns the validated revision as its output.
   In AI SDK v7 the tool part streams into the assistant message through
   `input-streaming` → `input-available` → `output-available`.
5. The client applies the revision when its tool part reaches `output-available`, through
   the single write path, which re-validates before mutating the store. The client never
   trusts the server's validation alone, because the document may have changed in the
   browser in the interim.
6. The client MUST NOT use `onToolCall` for this tool. `onToolCall` is for client-side
   tools; using it here would apply the edit twice.

## Failure Modes the Client Must Handle

| Event | Client behavior |
|---|---|
| `validation_error` | Show the error in chat; keep the document unchanged |
| `stale_conflict` | Show a conflict notice; offer to retry against current text; keep the document unchanged |
| `clear_requires_confirmation` | Show a confirmation prompt; apply only on explicit user action |
| stream ends with no tool call and no text | Show "the assistant produced no change"; keep the document unchanged |
| stream aborts or times out | Show a timeout error; keep the document unchanged |
