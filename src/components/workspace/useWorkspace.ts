"use client";

/**
 * The script library and the active script, shared by every panel.
 *
 * The sidebar renders the list, the chat panel needs the active script's ids,
 * and the store holds the text itself (Principle III). This hook owns only the
 * *library* — which scripts exist and which one is open — so the two panels
 * cannot disagree about the selection.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import {
  useConversation,
  type Conversation,
  type ConversationSeed,
} from "@/components/workspace/useConversation";
import { restoredMessages } from "@/components/chat/restored-messages";
import { discardRecoveryCopy, readRecoveryCopy } from "@/lib/editor/recovery-copy";
import type { Script, ScriptSummary } from "@/lib/domain/types";
import {
  assignScriptStyle,
  createScript,
  deleteScript,
  getScript,
  listScripts,
  listScriptMessages,
  type CreateScriptInput,
} from "@/lib/http/workspace-api";
import type { ApiError } from "@/lib/http/client";
import { useDocumentStore } from "@/stores/document-store";

/** The seed plus the failure, if any, of the history read that produced it. */
type Seed = ConversationSeed & { readonly error: ApiError | null };

export interface WorkspaceLibrary {
  /** The sidebar's list, most recently modified first (FR-002). */
  readonly scripts: readonly ScriptSummary[];
  /** The open script with its document and conversation id, or `null`. */
  readonly active: Script | null;
  readonly activeConversationId: string | null;
  readonly activeStyleId: string | null;
  /** The active script's conversation; panels read turns and send prompts here. */
  readonly conversation: Conversation;
  readonly error: ApiError | null;
  /**
   * The active script's history could not be read, so the chat starts blank.
   * Its document still opened, which is why this is separate from `error`.
   */
  readonly conversationError: ApiError | null;
  /**
   * The active script's conversation is bound but its history has not arrived
   * yet. The chat panel says so rather than showing an empty conversation.
   */
  readonly restoringConversation: boolean;
  /** Re-reads the list; called after any write that changes it. */
  refresh(): Promise<void>;
  /** Loads a script's document into the store, replacing the previous one. */
  open(scriptId: string): Promise<ApiError | null>;
  /** Creates a script and opens it; the caller shows the failure. */
  create(input: CreateScriptInput): Promise<ApiError | null>;
  /**
   * Replaces the active script's style with exactly one from the catalogue
   * (FR-009). The document is untouched: only the next AI request changes.
   * Resolves `null` once saved, or the failure to show.
   */
  assignStyle(styleId: string): Promise<ApiError | null>;
  /**
   * Deletes a script and everything it owns (FR-001d). Deleting the open
   * script returns the workspace to the list with nothing selected; deleting
   * another leaves the open one exactly as it is.
   */
  remove(scriptId: string): Promise<ApiError | null>;
}

const WorkspaceContext = createContext<WorkspaceLibrary | null>(null);

/**
 * One library per workspace, shared by every panel.
 *
 * Two independent hooks would give the sidebar and the chat panel different
 * ideas of which script is active; the provider is what keeps them one.
 */
export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const workspace = useLibrary();

  return createElement(WorkspaceContext.Provider, { value: workspace }, children);
}

/** The workspace library. Fails loudly outside its provider, a wiring bug. */
export function useWorkspace(): WorkspaceLibrary {
  const workspace = useContext(WorkspaceContext);

  if (workspace === null) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }

  return workspace;
}

function useLibrary(): WorkspaceLibrary {
  const [scripts, setScripts] = useState<readonly ScriptSummary[]>([]);
  const [active, setActive] = useState<Script | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null);
  const requested = useRef<string | null>(null);
  const conversation = useConversation({
    scriptId: active?.id ?? null,
    conversationId: activeConversationId,
    seed,
  });

  const refresh = useCallback(async () => {
    const result = await listScripts();

    if (result.ok) {
      setScripts(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the load's `setState` lands outside the effect body;
    // the list is server data arriving after mount, not derived state.
    const timer = setTimeout(() => void refresh(), 0);

    return () => clearTimeout(timer);
  }, [refresh]);

  const open = useCallback(async (scriptId: string): Promise<ApiError | null> => {
    requested.current = scriptId;
    const result = await getScript(scriptId);

    if (!result.ok) {
      setError(result.error);
      return result.error;
    }

    // A later `open` has already bound another script (or this script again):
    // this response is out of date and must not overwrite what is on screen.
    if (requested.current !== scriptId) {
      return null;
    }

    const { conversationId, ...script } = result.data;

    // The script and its conversation are bound in one update, and the
    // conversation is entered only once its history has been read: the chat is
    // keyed by conversation id and starts empty, so from the bind until the
    // read lands the panel shows "restoring" rather than the previous script's
    // turns (FR-003, FR-006, SC-008). The editor switches at the bind.
    setActive(script);
    setActiveConversationId(conversationId);
    setError(null);
    // The store replaces the previous document rather than merging it, so a
    // switch never leaves one script's text in another (FR-006).
    useDocumentStore.getState().loadScript({
      scriptId: script.id,
      conversationId,
      content: script.content,
      updatedAt: script.updatedAt,
    });

    // A local copy left by a failed save is offered only while the server
    // still lacks its text. Opening the script is the moment to check: once
    // the server has reached that text by any route (a later save, another
    // tab), restoring the copy would change nothing, so it is not offered.
    const stale = readRecoveryCopy({ scriptId: script.id });

    if (stale !== null && stale.savedContent === script.content) {
      discardRecoveryCopy({ scriptId: script.id });
    }

    const turns = await listScriptMessages(scriptId);

    if (requested.current !== scriptId) {
      return null;
    }

    // A history that could not be read leaves the chat usable and says so; the
    // document, which did load, is what the user came for (FR-003).
    setSeed({
      conversationId,
      messages: turns.ok ? restoredMessages(turns.data) : [],
      error: turns.ok ? null : turns.error,
    });

    return null;
  }, []);

  const create = useCallback(
    async (input: CreateScriptInput): Promise<ApiError | null> => {
      requested.current = null;
      const result = await createScript(input);

      if (!result.ok) {
        return result.error;
      }

      const created = result.data;

      setActive({
        id: created.id,
        title: created.title,
        content: created.content,
        styleId: created.styleId,
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
      });
      setActiveConversationId(created.conversationId);
      // A new script's conversation is empty by construction (FR-001).
      setSeed({ conversationId: created.conversationId, messages: [], error: null });
      useDocumentStore.getState().loadScript({
        scriptId: created.id,
        conversationId: created.conversationId,
        content: created.content,
        updatedAt: created.createdAt,
      });
      await refresh();

      return null;
    },
    [refresh],
  );

  const assignStyle = useCallback(
    async (styleId: string): Promise<ApiError | null> => {
      if (active === null) {
        return null;
      }

      const target: string = active.id;
      const result = await assignScriptStyle(target, styleId);

      if (!result.ok) {
        return result.error;
      }

      const applied = result.data.styleId;

      // Only the open script's association is updated: a reply for a script the
      // user has since left must not relabel the one on screen.
      let appliedToOpenScript = false;
      setActive((current) => {
        appliedToOpenScript = current?.id === target;

        return appliedToOpenScript && current !== null
          ? { ...current, styleId: applied }
          : current;
      });

      if (!appliedToOpenScript) {
        return null;
      }

      await refresh();

      return null;
    },
    [active, refresh],
  );

  const remove = useCallback(
    async (scriptId: string): Promise<ApiError | null> => {
      const result = await deleteScript(scriptId);

      if (!result.ok) {
        return result.error;
      }

      if (active?.id === scriptId) {
        // Nothing of a deleted script may remain addressed (spec Edge Cases):
        // no selection, no document, and no conversation bound to it.
        requested.current = null;
        setActive(null);
        setActiveConversationId(null);
        setSeed(null);
        useDocumentStore.getState().clearScript();
      }

      await refresh();

      return null;
    },
    [active, refresh],
  );

  return {
    scripts,
    active,
    activeConversationId,
    activeStyleId: active?.styleId ?? null,
    conversation,
    restoringConversation:
      activeConversationId !== null && seed?.conversationId !== activeConversationId,
    error,
    conversationError: active === null ? null : (seed?.error ?? null),
    refresh,
    open,
    create,
    assignStyle,
    remove,
  };
}
