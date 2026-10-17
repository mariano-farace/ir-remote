# Data Model: Script Workspace

**Feature**: `001-script-workspace` | **Date**: 2026-10-17 | **Plan**: [plan.md](./plan.md)

Derived from the spec's Key Entities and Functional Requirements. No framework or
language specifics appear here; the storage mapping is in
[contracts/http-api.md](./contracts/http-api.md) and the migrations.

## Entity Overview

```text
Style (static, seeded)          Script
   │                              │ 1
   │ 0..1                         │
   └──────────────< belongs to >──┤
                                  │ 1
                       ┌──────────┴──────────┐
                       │                     │
                  Conversation           ScriptVersion
                       │ 1                   (0..n, ordered)
                       │
                  Message (0..n, ordered)
```

A Script owns exactly one Conversation and zero or more ScriptVersions. A Style is
referenced by many Scripts but is not owned by any. PendingRevision is not persisted as an
entity of its own; it exists transiently in one request and is recorded as the resulting
ScriptVersion when applied.

---

## Script

A documentary script document.

| Field | Type | Rules |
|---|---|---|
| `id` | identifier | Unique, stable, never reused |
| `title` | text | **Required, supplied by the user at creation.** Trimmed, 1–200 characters, non-blank, unique case-insensitively on the trimmed value. Never auto-generated; can be changed by rename |
| `content` | Markdown text | May be empty. No artificial maximum, but the workspace warns past 50 000 characters |
| `styleId` | reference to Style, nullable | At most one. Setting it replaces any previous value |
| `createdAt` | timestamp | Set on creation, immutable |
| `updatedAt` | timestamp | Updated on every content change |

**Invariants**

- A Script MUST belong to exactly one Conversation (created with it, never orphaned).
- `title` MUST be non-blank after trimming and unique case-insensitively among all Scripts.
  Uniqueness is enforced by a database constraint on the normalized (lowercased, trimmed)
  title, not only by application validation, so a race cannot produce two identically
  titled scripts.
- `styleId` MUST reference a Style that exists in the catalogue.
- Content changes MUST append a ScriptVersion before the new content is persisted.

**Validation from requirements**: FR-001 (creation), FR-005 (save state), FR-006
(isolation), FR-009 (single style).

---

## Style

A predefined writing style. Fixed content shipped with the application, not user data.

| Field | Type | Rules |
|---|---|---|
| `id` | identifier | Stable, referenced by Scripts. Never renamed once referenced |
| `name` | text | Shown in the selector. Unique |
| `description` | text | One line, shown beside the name |
| `guidance` | text | The instruction given to the AI. Never shown to the user in the conversation |

**Invariants**

- Styles are created only by the seed; no write path exists for user modification
  (FR-008).
- `guidance` MUST NOT appear in any Message (FR-011).
- Deleting a referenced Style is not supported in this feature.

**Validation from requirements**: FR-007, FR-008, FR-010, FR-011.

---

## Conversation

The exchange of messages for one Script. Modelled as a distinct entity because it is
restored and isolated independently of the text (FR-003, FR-006), but it has no fields
beyond its identity and its owning Script.

| Field | Type | Rules |
|---|---|---|
| `id` | identifier | Unique |
| `scriptId` | reference to Script | Exactly one owner, unique: one Conversation per Script |
| `createdAt` | timestamp | Set on creation |

**Invariants**

- Exactly one Conversation per Script.
- Messages are ordered by `createdAt` then by insertion sequence, so that messages created
  in the same millisecond keep their order.

---

## Message

A single entry in a Conversation.

| Field | Type | Rules |
|---|---|---|
| `id` | identifier | Unique |
| `conversationId` | reference to Conversation | Required |
| `role` | one of `user`, `assistant` | No other roles are persisted |
| `content` | text | Required for `user`. For `assistant`, may be a short description of the applied change rather than the full document |
| `createdAt` | timestamp | Required |

**Invariants**

- A Message MUST NOT carry the full script body as its content; the script lives in Script
  (FR-016). The assistant's Message describes what changed; the change itself is in the
  document.
- The Style guidance is never a Message (FR-011).

---

## ScriptVersion

A recoverable prior state of a Script's content.

| Field | Type | Rules |
|---|---|---|
| `id` | identifier | Unique |
| `scriptId` | reference to Script | Required |
| `content` | Markdown text | The document text as it was before the change that created this version |
| `origin` | one of `user`, `assistant` | Which write path produced the change that superseded this version |
| `createdAt` | timestamp | Required, monotonic per script |

**Invariants**

- A ScriptVersion is immutable once written.
- Versions for a Script are ordered by `createdAt`; the most recent is the undo target.
- Every content change MUST write a new ScriptVersion first (FR-004, FR-020).
- Retention: versions are kept without automatic pruning in this feature. If pruning is
  added later, it MUST guarantee at least the most recent N versions remain restorable, per
  the constitution's Recoverability rule.

---

## PendingRevision (transient)

An AI-proposed change awaiting application. Not a persisted entity; it is the validated
payload of one tool call.

| Field | Type | Rules |
|---|---|---|
| `targetRegion` | span in the document | Identifies the text the AI intends to replace. Must be resolvable to an exact substring |
| `expectedText` | text | The text the target region held when the revision was computed |
| `replacementText` | text | The new text for that region only |

**Invariants**

- `expectedText` MUST equal the text currently occupying `targetRegion` at apply time.
  Otherwise the revision is rejected as stale (FR-015b).
- `replacementText` MUST NOT be empty when the document is non-empty, unless the user has
  explicitly confirmed (FR-021).
- The revision MUST NOT describe changes outside `targetRegion` (FR-015a).
- The single exception to region-addressing is the first draft into an empty document
  (FR-015c), where the whole document is the region.

---

## State Transitions

### Script lifecycle

```text
(none) --create--> Draft (empty content, conversation created, style optional)
Draft --first AI draft--> Generated (content non-empty)
Generated <--AI revision / manual edit--> Revised
any state --save fails--> SaveFailed (content retained in editor; UI reports failure)
```

There is no Delete transition in this feature.

### Document content change

Every path that changes `content` follows the same sequence, regardless of origin:

```text
1. capture current content as a ScriptVersion (origin = user | assistant)
2. validate the proposed change
   - region-addressed: expectedText must match the region
   - anti-clear: reject empty replacement over non-empty content without confirmation
3. apply the change to the document
4. update updatedAt
5. persist; on failure, keep the in-editor content and report SaveFailed
```

This sequence is the single write path required by Principle III. There is no alternate
route from a tool call or a keystroke to persisted content.
