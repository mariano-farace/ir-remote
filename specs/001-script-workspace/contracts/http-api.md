# Contract: HTTP API

**Feature**: `001-script-workspace` | **Date**: 2026-10-17

Route handlers of the single Next.js application. All responses are JSON. Errors use one
envelope; success returns the resource or a result object.

## Envelope

```jsonc
// success
{ "data": { /* resource or result */ } }

// error
{ "error": { "code": "string", "message": "human readable, English" } }
```

`message` is safe to show to the user. It never includes stack traces, SQL, API keys, or
prompt contents.

## Endpoints

### `GET /api/scripts`

Lists scripts for the sidebar (FR-002).

```jsonc
{ "data": [ { "id", "title", "styleId", "updatedAt" } ] }
```

Ordered by `updatedAt` descending (FR-002).

---

### `POST /api/scripts`

Creates a script and its conversation atomically (FR-001).

Request: `{ "title": string, "styleId": string | null }`

- `title` is **required**. Blank-after-trim → `400` `{ "error": { "code": "title_required" } }`.
- Duplicate title → `409` `{ "error": { "code": "title_taken" } }`.
- `styleId` is optional; defaults to the default style.

Response `201`: `{ "data": { "id", "title", "content", "styleId", "conversationId" } }`

Invariant: the Script and its Conversation are created in one transaction. A Script with
no Conversation or no title MUST NOT be observable.

---

### `GET /api/scripts/{id}`

Returns the script with its content (FR-003).

```jsonc
{ "data": { "id", "title", "content", "styleId", "updatedAt" } }
```

---

### `GET /api/scripts/{id}/messages`

Returns the conversation (FR-003).

```jsonc
{ "data": [ { "id", "role", "content", "createdAt" } ] }
```

Ordered by creation. The Style guidance never appears here (FR-011).

---

### `PUT /api/scripts/{id}/content`

Autosave target (FR-004, FR-005).

Request: `{ "content": string, "baseUpdatedAt": string }`

`baseUpdatedAt` is the `updatedAt` the client last observed. If the stored `updatedAt` is
newer, the server responds `409` with `{ "error": { "code": "stale_write" } }` and the
client resolves the conflict rather than overwriting (FR-019).

Response `200`: `{ "data": { "updatedAt" } }`

Side effect: writes a ScriptVersion capturing the previous content before applying
(FR-020).

---

### `DELETE /api/scripts/{id}`

Deletes a script with its conversation and version history (FR-001d).

Requires a confirmation token in the request body: `{ "confirm": true }`. Without it, `400`
`{ "error": { "code": "confirmation_required" } }`.

Response `204`. Deletion is transactional: the script, its conversation, its messages, and
its revisions are removed together or not at all.

---

### `PATCH /api/scripts/{id}`

Renames a script (FR-001c).

Request: `{ "title": string }`

Same rules as creation: blank → `400 title_required`; duplicate → `409 title_taken`.
Renaming to the current title is a no-op success.

Response `200`: `{ "data": { "id", "title", "updatedAt" } }`

---

### `PUT /api/scripts/{id}/style`

Assigns or replaces the single style (FR-009).

Request: `{ "styleId": string }`. Response `200`: `{ "data": { "styleId" } }`.

Validation: `styleId` MUST exist in the catalogue; there is no endpoint to create a style
(FR-008).

---

### `GET /api/styles`

Returns the static catalogue (FR-007). Omits `guidance` (FR-011).

```jsonc
{ "data": [ { "id", "name", "description" } ] }
```

---

### `GET /api/scripts/{id}/revisions`

Lists recoverable versions, newest first (FR-020), for the undo affordance.

```jsonc
{ "data": [ { "id", "chronological index", "createdAt", "origin", "preview" } ] }
```

`preview` is the first 200 characters, not the full content.

---

### `POST /api/scripts/{id}/revisions/{versionId}/restore`

Restores a prior version (FR-020, FR-021).

Response `200`: `{ "data": { "content", "updatedAt" } }`.

Side effect: the current content becomes a new ScriptVersion before the restore, so undo
is itself undoable.

---

### `POST /api/chat`

Streams the assistant's response and its tool call (FR-012, FR-013, FR-016).

Request: `{ "scriptId": string, "conversationId": string, "message": string }`

Server behavior:

1. Loads the script's current content and its style guidance **server-side**. The client
   does not supply the document or the system prompt — this is what makes FR-014 and
   FR-018 true rather than aspirational.
2. Builds the system prompt from the style's `guidance` plus the current document.
3. Streams the model response using the tool defined in
   [tool-call.md](./tool-call.md).
4. Persists the user Message immediately; persists the assistant Message when the change
   is applied.

Response: a UI message stream built with
`createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`
(AI SDK v7). The tool part and its failure states are defined in
[tool-call.md](./tool-call.md#failure-modes-the-client-must-handle).

Error cases: missing API key at boot is a startup failure, not a request failure
(constitution, Security). Upstream timeout → `504`-equivalent streamed error event within
the 60 s bound (FR-023).

## Cross-cutting Rules

- **No client-supplied document text on AI requests.** Accepting it would let a stale
  client silently poison FR-014.
- **No style guidance in any response.** Only the catalogue's name and description are
  exposed.
- **All writes transactional.** A content write that cannot record its ScriptVersion MUST
  fail rather than succeed without history.
- **Errors are actionable.** Every `code` has a corresponding user-facing message the
  client can render without inventing copy.
