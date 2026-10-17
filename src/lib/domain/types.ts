/**
 * Domain types for a script and everything it owns.
 *
 * This module is deliberately framework-free: no React, no HTTP, no database
 * driver. It is the vocabulary shared by the domain layer (which is unit-tested
 * to a 95% floor) and the repository implementations (which are tested against
 * a real PostgreSQL). See specs/001-script-workspace/data-model.md.
 *
 * Every interface here is read-only. A change to domain state produces a new
 * value rather than mutating one in place, which is what keeps the single write
 * path in `src/stores/document-store.ts` observable.
 */

/** Identifiers are opaque strings; the database generates UUIDs for scripts. */
export type ScriptId = string;
export type ConversationId = string;
export type MessageId = string;
export type ScriptVersionId = string;
export type StyleId = string;

/** A timestamp is an ISO 8601 string, the form a JSON route handler emits. */
export type IsoTimestamp = string;

/** The only speakers a Message may have. No system or tool role is persisted. */
export type MessageRole = "user" | "assistant";

/** Which write path produced the change that superseded a ScriptVersion. */
export type RevisionOrigin = MessageRole;

/** A predefined writing style. Fixed content shipped with the application. */
export interface Style {
  readonly id: StyleId;
  readonly name: string;
  readonly description: string;
  /**
   * The instruction handed to the model as part of the system prompt. Never
   * shown to the user in a conversation (FR-011), so it is absent from the
   * style catalogue the HTTP layer exposes.
   */
  readonly guidance: string;
}

/** The fields of a style that may be shown to the user. */
export type StyleSummary = Pick<Style, "id" | "name" | "description">;

/** A documentary script: the document itself and its metadata. */
export interface Script {
  readonly id: ScriptId;
  readonly title: string;
  /** Markdown text. May be empty; there is no artificial maximum. */
  readonly content: string;
  /** At most one style, nullable until the user assigns one. */
  readonly styleId: StyleId | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** The script fields the sidebar needs, without the document text (FR-002). */
export type ScriptSummary = Pick<Script, "id" | "title" | "styleId" | "updatedAt">;

/** The exchange of messages for exactly one script. */
export interface Conversation {
  readonly id: ConversationId;
  readonly scriptId: ScriptId;
  readonly createdAt: IsoTimestamp;
}

/** A single entry in a conversation. */
export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  /** For an assistant message, a description of the change, never the script body. */
  readonly content: string;
  readonly createdAt: IsoTimestamp;
}

/** A recoverable prior state of a script's content. Immutable once written. */
export interface ScriptVersion {
  readonly id: ScriptVersionId;
  readonly scriptId: ScriptId;
  /** The document text as it was before the change this version records. */
  readonly content: string;
  readonly origin: RevisionOrigin;
  readonly createdAt: IsoTimestamp;
}

/** A version as listed for the undo affordance: a preview, not the full content. */
export interface ScriptVersionPreview {
  readonly id: ScriptVersionId;
  /** 1-based position in the script's chronological history. */
  readonly index: number;
  readonly createdAt: IsoTimestamp;
  readonly origin: RevisionOrigin;
  /** The first 200 characters of the version's content. */
  readonly preview: string;
}

/**
 * An AI-proposed change awaiting application. Not a persisted entity: it is the
 * validated payload of one tool call, and becomes a ScriptVersion only through
 * the normal write path once applied.
 */
export interface PendingRevision {
  /** The span the revision intends to replace, resolved against the document. */
  readonly targetRegion: RevisionRegion;
  /**
   * The text the target region held when the revision was computed. Must equal
   * the text currently occupying the region at apply time, or the revision is
   * rejected as stale (FR-015b).
   */
  readonly expectedText: string;
  /** The new text for that region only. */
  readonly replacementText: string;
  /** How the revision is applied: a first draft, a targeted edit, or a rewrite. */
  readonly kind: RevisionKind;
  /** One sentence describing the change, shown in the chat. Max 200 characters. */
  readonly summary: string;
}

/**
 * Where a revision applies. `anchor` names a verbatim quote that must occur
 * exactly once in the document; `whole-document` is the only non-anchored case
 * and is permitted only for a first draft or a confirmed rewrite (FR-015c).
 */
export type RevisionRegion =
  | { readonly type: "anchor"; readonly anchorText: string }
  | {
      readonly type: "whole-document";
    };

/** The three cases a revision can fall into (FR-012, FR-015, FR-015c). */
export type RevisionKind = "first-draft" | "targeted" | "wholesale-rewrite";
