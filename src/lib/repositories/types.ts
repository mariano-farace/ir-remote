/**
 * The repository boundary.
 *
 * The constitution's MVP Scope Boundaries require data access to sit behind an
 * interface, so the PostgreSQL implementation stays swappable without touching
 * domain logic. Nothing in this file imports `pg`, React, or Next.js; a caller
 * that depends only on these interfaces cannot tell which store is behind them.
 *
 * Failures are reported as `RepositoryError` values with a machine-readable
 * `code`, never as thrown driver errors. Route handlers map the code onto an
 * HTTP status and a user-facing message (contracts/http-api.md), so the mapping
 * lives in one place rather than in every caller.
 */

import type {
  Conversation,
  ConversationId,
  IsoTimestamp,
  Message,
  MessageId,
  MessageRole,
  RevisionOrigin,
  Script,
  ScriptId,
  ScriptSummary,
  ScriptVersion,
  ScriptVersionId,
  ScriptVersionPreview,
  Style,
  StyleId,
} from "@/lib/domain/types";

/**
 * The distinguishable failure causes a repository can report.
 *
 * Each code has exactly one HTTP mapping (contracts/http-api.md) and one
 * user-facing message, which is what makes FR-022a possible: a caller can tell
 * a title collision from a missing script without inspecting a driver error.
 */
export type RepositoryErrorCode =
  | "title_required"
  | "title_taken"
  | "unknown_style"
  | "not_found"
  | "stale_write"
  /** The request carried a value that cannot mean anything, such as a malformed timestamp. */
  | "invalid_request";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

/** A style returned by {@link StyleRepository.list}; the row's `createdAt` is not API surface. */
export type StoredStyle = Style;

/**
 * What creation needs. The script and its conversation are created together in
 * one transaction (FR-001), so callers never pass a conversation id.
 */
export interface NewScript {
  readonly title: string;
  /** `null` means "no style assigned yet"; the route layer decides any default. */
  readonly styleId: StyleId | null;
  /** The initial document text. Empty for a new script. */
  readonly content?: string;
}

/** The result of creating a script: the record and the conversation it owns. */
export interface CreatedScript {
  readonly script: Script;
  readonly conversation: Conversation;
}

/** What a content write produces: the new `updatedAt` the client must echo next time. */
export interface ContentWriteResult {
  readonly updatedAt: IsoTimestamp;
}

/** What a restore produces: the document it put back, and the `updatedAt` to echo next time. */
export interface RestoreResult extends ContentWriteResult {
  readonly content: string;
}

/**
 * The script operations every user story needs, including the content write
 * (available from US2 onward). `updateContent` lives here rather than only in
 * {@link ScriptMutationRepository} because it is the write path autosave and
 * revision restore share; see {@link RevisionRepository.restore}.
 */
export interface ScriptRepository {
  /** Every script, ordered by `updatedAt` descending (FR-002). Content is not included. */
  list(): Promise<readonly ScriptSummary[]>;

  /**
   * Creates the script and its conversation in one transaction. A script with
   * no conversation is never observable (FR-001).
   *
   * @throws {RepositoryError} `title_required` when the title is blank,
   *   `title_taken` on a normalized-title collision, `unknown_style` when
   *   `styleId` is not in the catalogue.
   */
  create(input: NewScript): Promise<CreatedScript>;

  /** Loads one script with its content. @throws {RepositoryError} `not_found`. */
  get(id: ScriptId): Promise<Script>;

  /**
   * Replaces the document text, writing the prior content as a ScriptVersion
   * first and refusing a write based on a stale `baseUpdatedAt` (FR-019,
   * FR-020). The version and the content land in one transaction: a write that
   * cannot record its history must fail rather than succeed without it.
   *
   * @throws {RepositoryError} `not_found`, `stale_write`.
   */
  updateContent(
    id: ScriptId,
    content: string,
    baseUpdatedAt: IsoTimestamp,
    origin: RevisionOrigin,
  ): Promise<ContentWriteResult>;
}

/**
 * The script's mutations that are neither creation nor a document write:
 * `rename` (T067, US3) and `assignStyle` (T074, US4).
 *
 * Kept apart from {@link ScriptRepository} because it is not itself a member of
 * {@link Repositories}: an operation joins the swap boundary with the tests that
 * prove it, never ahead of them.
 */
export interface ScriptMutationRepository {
  /**
   * Renames a script under the same rules as creation (FR-001c). Renaming to
   * the current title is a no-op success.
   *
   * @throws {RepositoryError} `not_found`, `title_required`, `title_taken`.
   */
  rename(id: ScriptId, title: string): Promise<ScriptSummary>;

  /**
   * Deletes the script with everything it owns, transactionally (FR-001d).
   * The conversation, its messages, and the version history cascade from the
   * script row, so a deleted script leaves nothing observable behind.
   *
   * @throws {RepositoryError} `not_found`.
   */
  delete(id: ScriptId): Promise<void>;

  /**
   * Assigns or replaces the single style (FR-009). The read-only catalogue
   * makes this a reference update on the script, not a write to `styles`.
   *
   * @throws {RepositoryError} `not_found`, `unknown_style`.
   */
  assignStyle(id: ScriptId, styleId: StyleId): Promise<{ readonly styleId: StyleId }>;
}

export interface ConversationRepository {
  /** Appends one message and returns it as stored. @throws {RepositoryError} `not_found`. */
  append(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<Message>;

  /**
   * The conversation's messages in creation order, with a stable tiebreak for
   * messages created in the same millisecond (FR-003, FR-006).
   *
   * @throws {RepositoryError} `not_found` when the conversation does not exist.
   */
  getMessages(conversationId: ConversationId): Promise<readonly Message[]>;

  /** The conversation owned by a script. @throws {RepositoryError} `not_found`. */
  getByScriptId(scriptId: ScriptId): Promise<Conversation>;
}

/**
 * The style catalogue. Writing is intentionally absent: styles are seeded
 * content, and no application path may create, edit, or delete one (FR-008).
 */
export interface StyleRepository {
  /** The whole catalogue in insertion order. Includes `guidance`; the route strips it. */
  list(): Promise<readonly StoredStyle[]>;

  /**
   * One style by id.
   *
   * @throws {RepositoryError} `not_found` when the id is not in the catalogue.
   */
  get(id: StyleId): Promise<StoredStyle>;
}

export interface RevisionRepository {
  /** A script's versions, newest first (FR-020). Previews, not full content. */
  list(scriptId: ScriptId): Promise<readonly ScriptVersionPreview[]>;

  /**
   * Restores a prior version by replacing the document's content with it. The
   * content being replaced is itself recorded as a new version first, so the
   * restore is undoable (FR-020). The restore takes no `baseUpdatedAt`: the
   * version was chosen by the user from the history that the current content
   * produced, and there is no client document to reconcile against.
   *
   * @throws {RepositoryError} `not_found` for an unknown script or version.
   */
  restore(scriptId: ScriptId, versionId: ScriptVersionId): Promise<RestoreResult>;

  /** A single version with its full content, for tests and diagnostics. */
  get(scriptId: ScriptId, versionId: ScriptVersionId): Promise<ScriptVersion>;
}

/**
 * Everything a route handler or a store needs, resolved from one place.
 *
 * A field is added when its implementation and tests exist, never ahead of them.
 */
export interface Repositories {
  readonly scripts: ScriptRepository &
    Pick<ScriptMutationRepository, "delete" | "rename" | "assignStyle">;
  readonly conversations: ConversationRepository;
  readonly styles: StyleRepository;
  readonly revisions: RevisionRepository;
}

/** Re-exported so a caller can import the domain vocabulary from one module. */
export type { Message, MessageId, Script, ScriptVersion, Style };
