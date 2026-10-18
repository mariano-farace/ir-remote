/**
 * The active script's document state — the single source of truth (Principle III).
 *
 * Two callers write the document: the editor (the user typing) and the chat
 * panel (an AI tool result arriving). Both go through `applyProposal`, which
 * takes either the text the user now has or a `PendingRevision` from the model
 * and routes both through the same domain function the server used. There is
 * deliberately no `setContent`: a second way in would be the defect the
 * constitution names, and it would be invisible to the reconciliation the tool
 * path needs. `loadScript` replaces the whole active script when the user opens
 * another one; it is not a way to change the open document.
 *
 * The store is framework-light (Zustand only, no React import) so it can be
 * unit-tested without a renderer.
 */

import { create } from "zustand";

import { applyRevision } from "@/lib/domain/revision";
import { saveScriptContent } from "@/lib/http/workspace-api";
import type {
  IsoTimestamp,
  PendingRevision,
  ScriptId,
  ConversationId,
} from "@/lib/domain/types";

/**
 * What the save indicator shows (FR-005): every state a save can honestly be
 * in. `retrying` is distinct from `saving` on purpose — "still working on it"
 * and "it failed, trying again" are different things to tell the user.
 */
export type SaveState = "idle" | "saved" | "saving" | "retrying" | "failed";

/** The script currently open in the workspace. */
export interface ScriptSnapshot {
  readonly scriptId: ScriptId;
  readonly conversationId: ConversationId;
  readonly content: string;
  readonly updatedAt: IsoTimestamp;
}

/**
 * How a change is described to `applyProposal`. The editor reports the text
 * the user now has; the chat reports a `PendingRevision` carrying the text its
 * target region held. Both end at the same state transition.
 */
export type Proposal = string | PendingRevision;

/** What the user confirmed about a revision, when a change needed asking. */
export interface RevisionConsent {
  readonly clearConfirmed?: boolean;
  readonly rewriteConfirmed?: boolean;
}

export interface ProposalResult {
  readonly applied: boolean;
  /** The user-facing reason the change was refused, if it was. */
  readonly message?: string;
  /**
   * The revision would clear the script and is waiting for the user
   * (FR-021). The proposal was not applied; `requestClearConfirmation`
   * carries what the confirmation needs.
   */
  readonly needsClearConfirmation?: boolean;
}

/**
 * A clearing revision the server asked the user about, while the question is
 * open. It is a question, not a permission: the revision is applied only by
 * `confirmClear`, which runs the same proposal again with the user's consent.
 */
export interface PendingClear {
  /** The tool call the answer belongs to; the reply travels under its id. */
  readonly toolCallId: string;
  /** The server's approval id, returned with the user's answer. */
  readonly approvalId: string;
  readonly revision: PendingRevision;
}

/**
 * A whole-script rewrite the server asked the user about (FR-015c, second
 * case), while the question is open. Only `confirmRewrite` applies it, with the
 * user's consent, and `declineRewrite` closes it without writing.
 */
export interface PendingRewrite extends PendingClear {
  /** The user-facing description of the rewrite the model proposed. */
  readonly summary: string;
}

export interface DocumentState {
  readonly scriptId: ScriptId | null;
  readonly conversationId: ConversationId | null;
  /** Markdown. Mirrors the stored document except while a change is unsaved. */
  readonly content: string;
  /** The `updatedAt` the client last observed; the autosave precondition. */
  readonly updatedAt: IsoTimestamp | null;
  /** What the client has that the server does not. Persisted by `useAutosave`. */
  readonly persistedContent: string;
  readonly saveState: SaveState;
  /** The clearing revision the user is being asked about, if any (FR-021). */
  readonly pendingClear: PendingClear | null;
  /** The whole-script rewrite the user is being asked about, if any (FR-015c). */
  readonly pendingRewrite: PendingRewrite | null;

  /** Makes a script active, replacing any previous document (never merging). */
  loadScript(snapshot: ScriptSnapshot): void;

  /**
   * The only content mutator. Returns a typed outcome; never throws.
   *
   * `consent` is the user's answer to a question the change raised — a clear
   * it would make, or a rewrite it would perform — and comes only from the
   * user (FR-021, FR-015c), never from a model's claim.
   */
  applyProposal(proposal: Proposal, consent?: RevisionConsent): ProposalResult;

  /**
   * Records the server's request to confirm a clearing revision. The first
   * question wins: a replayed stream must not stack two of them.
   */
  requestClearConfirmation(pending: PendingClear): void;

  /**
   * The user said yes. The clearing revision runs through `applyProposal`
   * with the consent the domain's anti-clear guard requires, and the question
   * closes.
   */
  confirmClear(): ProposalResult;

  /** The user said no: nothing is written and the question closes. */
  declineClear(): void;

  /** A rewrite the server asked about, put to the user. The first question wins. */
  requestRewriteConfirmation(pending: PendingRewrite): void;

  /** The user confirmed the rewrite: it runs through `applyProposal` with consent. */
  confirmRewrite(): ProposalResult;

  /** The user declined the rewrite: nothing is written and the question closes. */
  declineRewrite(): void;

  /**
   * Persists `content` on the strength of the `updatedAt` the store holds (the
   * base the server checks against), and records the new `updatedAt` on
   * success. Rejects so the autosave scheduler can report the failure; it never
   * changes `content`.
   */
  saveContent(content: string): Promise<void>;

  /**
   * Returns the store to its initial, no-script state. Used when the open
   * script is deleted, so nothing of it stays addressable by autosave.
   */
  clearScript(): void;

  /** What the save indicator shows. Set by the autosave scheduler only. */
  setSaveState(saveState: SaveState): void;

  /**
   * Adopts a document the server produced and already stored — a restored
   * revision. This is not a write: nothing is sent, nothing is dirty, and
   * `updatedAt` is the server's, so the next autosave checks against it.
   */
  adoptPersisted(content: string, updatedAt: IsoTimestamp): void;
}

export const INITIAL_DOCUMENT_STATE = {
  scriptId: null,
  conversationId: null,
  content: "",
  updatedAt: null,
  persistedContent: "",
  saveState: "idle",
  pendingClear: null,
  pendingRewrite: null,
} as const satisfies Partial<DocumentState>;

/** The document has text, which gates the first-draft and anti-clear rules. */
export function selectHasContent(state: DocumentState): boolean {
  return state.content.trim() !== "";
}

/** The client holds a change the server has not acknowledged. */
export function selectIsDirty(state: DocumentState): boolean {
  return state.content !== state.persistedContent;
}

function refuse(message: string): ProposalResult {
  return { applied: false, message };
}

function applyEdit(state: DocumentState, content: string): ProposalResult {
  if (state.scriptId === null) {
    return refuse("Open a script before editing it.");
  }

  if (content === state.content) {
    return { applied: true };
  }

  useDocumentStore.setState({ content, saveState: "saving" });

  return { applied: true };
}

function applyProposedRevision(
  state: DocumentState,
  revision: PendingRevision,
  clearConfirmed: boolean,
  rewriteConfirmed = false,
): ProposalResult {
  if (state.scriptId === null) {
    return refuse("Open a script before requesting a change.");
  }

  // Re-validated here even when the server already validated it: the browser's
  // document may have changed while the request was in flight, and the text
  // the user is looking at now is the one this revision must agree with
  // (FR-015b, FR-019). The server's verdict describes the document it loaded;
  // this one describes the document in front of the user.
  const outcome = applyRevision(state.content, revision, {
    clearConfirmed,
    rewriteConfirmed,
  });

  if (!outcome.applied) {
    // The document is untouched: `applyRevision` returns a rejection before it
    // builds new content, so a stale or ambiguous revision cannot overwrite
    // a newer edit made in this browser (FR-015b, FR-019).
    return outcome.reason === "clear_requires_confirmation"
      ? { ...refuse(outcome.message), needsClearConfirmation: true }
      : refuse(outcome.message);
  }

  useDocumentStore.setState({ content: outcome.content, saveState: "saving" });

  return { applied: true };
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  ...INITIAL_DOCUMENT_STATE,

  loadScript(snapshot) {
    set({
      scriptId: snapshot.scriptId,
      conversationId: snapshot.conversationId,
      content: snapshot.content,
      persistedContent: snapshot.content,
      updatedAt: snapshot.updatedAt,
      saveState: "saved",
      pendingClear: null,
      pendingRewrite: null,
    });
  },

  applyProposal(proposal, consent) {
    const state = get();

    // A revision applied here has no user consent behind it unless it is
    // passed explicitly: only the user's answered approval can supply one —
    // for a clear (FR-021) or for a rewrite (FR-015c).
    return typeof proposal === "string"
      ? applyEdit(state, proposal)
      : applyProposedRevision(
          state,
          proposal,
          consent?.clearConfirmed === true,
          consent?.rewriteConfirmed === true,
        );
  },

  requestClearConfirmation(pending) {
    if (get().pendingClear !== null) {
      return;
    }

    set({ pendingClear: pending });
  },

  confirmClear() {
    const { pendingClear } = get();

    if (pendingClear === null) {
      return refuse("There is no change waiting for confirmation.");
    }

    // This call is the consent: the user answered "yes" to exactly this
    // revision. The question closes whether or not the revision still applies.
    const result = applyProposedRevision(get(), pendingClear.revision, true);

    set({ pendingClear: null });

    return result;
  },

  declineClear() {
    set({ pendingClear: null });
  },

  requestRewriteConfirmation(pending) {
    if (get().pendingRewrite !== null) {
      return;
    }

    set({ pendingRewrite: pending });
  },

  confirmRewrite() {
    const { pendingRewrite } = get();

    if (pendingRewrite === null) {
      return refuse("There is no rewrite waiting for confirmation.");
    }

    // The user's yes is the consent FR-015c requires; the question closes
    // whether or not the revision still applies.
    const result = applyProposedRevision(get(), pendingRewrite.revision, false, true);

    set({ pendingRewrite: null });

    return result;
  },

  declineRewrite() {
    set({ pendingRewrite: null });
  },

  clearScript() {
    set({ ...INITIAL_DOCUMENT_STATE });
  },

  setSaveState(saveState) {
    set({ saveState });
  },

  adoptPersisted(content, updatedAt) {
    if (typeof content !== "string" || content === "" || typeof updatedAt !== "string") {
      // A malformed adoption would blank the editor with nothing to undo it
      // from, so the only outcomes are a complete document or no change.
      throw new Error("A persisted document needs content and its updatedAt");
    }

    set({
      content,
      persistedContent: content,
      updatedAt,
      saveState: "saved",
    });
  },

  async saveContent(content) {
    const { scriptId, updatedAt } = get();

    if (scriptId === null) {
      throw new Error("No script is open, so there is nothing to save");
    }

    if (updatedAt === null) {
      throw new Error("The script has not been loaded, so it cannot be saved yet");
    }

    const result = await saveScriptContent(scriptId, {
      content,
      baseUpdatedAt: updatedAt,
    });

    if (!result.ok) {
      throw new SaveError(result.error.code, result.error.message);
    }

    // Only the acknowledgement moves: the user may have typed again while the
    // save was in flight, and that newer text must stay unsaved until it is.
    set({
      persistedContent: content,
      updatedAt: result.data.updatedAt,
    });
  },
}));

/** A refused save, carrying the server's code so the UI can tell causes apart (FR-022a). */
export class SaveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SaveError";
    this.code = code;
  }
}
