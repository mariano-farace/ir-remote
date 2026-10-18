import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingRevision } from "@/lib/domain/types";
import {
  INITIAL_DOCUMENT_STATE,
  selectHasContent,
  SaveError,
  selectIsDirty,
  useDocumentStore,
} from "@/stores/document-store";

import { acceptedSave } from "../support/persisted-saves";

const saveScriptContent = vi.fn();

vi.mock("@/lib/http/workspace-api", () => ({
  saveScriptContent: (...args: unknown[]) => saveScriptContent(...args),
}));

/**
 * Constitution Principle III: the store is the single source of truth for the
 * active document, and `applyProposal` is the only way its text changes.
 *
 * The store deliberately does not depend on the chat panel: this test drives it
 * directly. Components are free to call these actions, but nothing else may
 * write text.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const CONVERSATION_ID = "20c4c1a0-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-17T10:00:00.000Z";

const FIRST_DRAFT: PendingRevision = {
  targetRegion: { type: "whole-document" },
  expectedText: "",
  replacementText: "# The Bronze Age\n\nAround 1200 BCE, the networks fell.",
  kind: "first-draft",
  summary: "Wrote a first draft.",
};

/** Quotes the draft's second sentence; it occurs exactly once in the draft. */
const TARGETED: PendingRevision = {
  targetRegion: { type: "anchor", anchorText: "the networks fell." },
  expectedText: "the networks fell.",
  replacementText: "the networks collapsed.",
  kind: "targeted",
  summary: "Sharpened the second sentence.",
};

function loadScript(content = ""): void {
  useDocumentStore.getState().loadScript({
    scriptId: SCRIPT_ID,
    conversationId: CONVERSATION_ID,
    content,
    updatedAt: UPDATED_AT,
  });
}

function apply(proposal: PendingRevision | string) {
  return useDocumentStore.getState().applyProposal(proposal);
}

beforeEach(() => {
  useDocumentStore.setState({ ...INITIAL_DOCUMENT_STATE });
  saveScriptContent.mockReset();
  saveScriptContent.mockImplementation(
    async (scriptId: string, body?: { content?: string }) => acceptedSave(scriptId, body),
  );
});

afterEach(() => {
  saveScriptContent.mockReset();
});

describe("document store", () => {
  describe("initial state", () => {
    it("has no active script and an empty document", () => {
      expect(useDocumentStore.getState()).toMatchObject({
        scriptId: null,
        conversationId: null,
        content: "",
        updatedAt: null,
        saveState: "idle",
      });
    });

    it("reports no content and no pending change", () => {
      const state = useDocumentStore.getState();

      expect(selectHasContent(state)).toBe(false);
      expect(selectIsDirty(state)).toBe(false);
    });
  });

  describe("the only content mutator", () => {
    it("names exactly one content-writing action in the store's state", () => {
      // A name list only catches names someone thought of. The structural check
      // is that every action the store exposes either leaves `content` alone
      // or is `applyProposal`: there is no second entry point of any name.
      const actions = Object.entries(useDocumentStore.getState()).filter(
        ([, value]) => typeof value === "function",
      );

      // `loadScript` replaces the active script and `adoptPersisted` takes a
      // document the server already stored (a restored revision); neither is a
      // user edit. `clearScript` removes the document after a deletion, which
      // is a different transition from changing it (covered in
      // document-loading.test.ts). `saveContent` and `setSaveState` are the
      // autosave scheduler's verbs and never write text (the behavioural check
      // below is what proves it). The clear-confirmation actions are the
      // anti-clear guard (FR-021): `confirmClear` is the user's answer to a
      // question the store is holding, and it writes only through
      // `applyProposal`; `requestClearConfirmation` and `declineClear` never
      // write. clear-confirmation.test.ts exercises each of them. The
      // rewrite-confirmation actions are the same shape for FR-015c's second
      // case, and rewrite-confirmation.test.ts exercises each of them.
      expect(actions.map(([name]) => name).sort()).toEqual([
        "adoptPersisted",
        "applyProposal",
        "clearScript",
        "confirmClear",
        "confirmRewrite",
        "declineClear",
        "declineRewrite",
        "loadScript",
        "requestClearConfirmation",
        "requestRewriteConfirmation",
        "saveContent",
        "setSaveState",
      ]);

      for (const forbidden of ["setContent", "updateContent", "replaceContent"]) {
        expect(useDocumentStore.getState()).not.toHaveProperty(forbidden);
      }
    });

    it("changes text through applyProposal alone: no other action touches content", () => {
      // Observed rather than grep-ed for: call every other action and watch the
      // text. `loadScript` and `adoptPersisted` replace the active document
      // legitimately (opening a script; taking a restored revision the server
      // already stored), so they are called with a well-formed document and
      // their replacement is the only change they may make. Everything else
      // leaves the text exactly as it was.
      loadScript("Before.");
      apply("Before, edited.");

      const afterEdit = useDocumentStore.getState().content;

      loadScript("Before, edited.");
      useDocumentStore.getState().adoptPersisted("A restored revision.", UPDATED_AT);

      expect(useDocumentStore.getState()).toMatchObject({
        content: "A restored revision.",
        persistedContent: "A restored revision.",
      });

      loadScript(afterEdit);

      // `clearScript` removes the document rather than changing it: it is the
      // no-script state that follows a deletion, and is exercised on its own
      // below. It is excluded here because calling it would leave no text to
      // compare, which would make this test pass without checking anything.
      // `confirmClear` and `confirmRewrite` are excluded because they are
      // answers to questions nobody asked here: each refuses without one, which
      // the clear- and rewrite-confirmation tests prove, and with one it runs
      // `applyProposal` — the same path the whole test is about.
      const actions = Object.entries(useDocumentStore.getState()).filter(
        ([name, value]) =>
          typeof value === "function" &&
          ![
            "applyProposal",
            "loadScript",
            "adoptPersisted",
            "clearScript",
            "confirmClear",
            "confirmRewrite",
          ].includes(name),
      );

      for (const [, action] of actions) {
        (action as (...args: unknown[]) => unknown)();
      }

      expect(useDocumentStore.getState().content).toBe(afterEdit);
    });

    it("refuses an adoption with no document, rather than blanking the editor", () => {
      loadScript("Existing words.");

      expect(() =>
        useDocumentStore
          .getState()
          .adoptPersisted(undefined as unknown as string, UPDATED_AT),
      ).toThrow();
      expect(useDocumentStore.getState().content).toBe("Existing words.");
    });
  });

  describe("loading a script", () => {
    it("makes the script active with the document it was stored with", () => {
      loadScript(FIRST_DRAFT.replacementText);

      expect(useDocumentStore.getState()).toMatchObject({
        scriptId: SCRIPT_ID,
        conversationId: CONVERSATION_ID,
        content: FIRST_DRAFT.replacementText,
        updatedAt: UPDATED_AT,
        saveState: "saved",
      });
      expect(selectIsDirty(useDocumentStore.getState())).toBe(false);
    });

    it("replaces the previous script's document rather than merging it (FR-006)", () => {
      loadScript("The previous script's text.");
      loadScript("");

      expect(useDocumentStore.getState().content).toBe("");
      expect(useDocumentStore.getState().persistedContent).toBe("");
    });
  });

  describe("applyProposal", () => {
    describe("a revision", () => {
      it("is the one mutator for an AI change: a first draft fills an empty document", () => {
        loadScript();

        const result = apply(FIRST_DRAFT);

        expect(result).toEqual({ applied: true });
        expect(useDocumentStore.getState().content).toBe(FIRST_DRAFT.replacementText);
        expect(selectIsDirty(useDocumentStore.getState())).toBe(true);
      });

      it("refuses a first draft over a non-empty document, leaving it untouched (FR-015c)", () => {
        loadScript("Existing words.");

        const result = apply({ ...FIRST_DRAFT, expectedText: "Existing words." });

        expect(result.applied).toBe(false);
        expect(result.message).toMatch(/empty/i);
        expect(useDocumentStore.getState().content).toBe("Existing words.");
      });

      it("replaces only the anchored region", () => {
        loadScript(FIRST_DRAFT.replacementText);

        apply(TARGETED);

        expect(useDocumentStore.getState().content).toBe(
          "# The Bronze Age\n\nAround 1200 BCE, the networks collapsed.",
        );
      });

      it("reports a conflict, not an ambiguity, when an edit already touched the target (FR-015b)", () => {
        loadScript(FIRST_DRAFT.replacementText);
        const edited = FIRST_DRAFT.replacementText.replace(
          "the networks fell.",
          "the networks buckled.",
        );
        apply(edited);

        const result = apply(TARGETED);

        // The anchor quote is naturally gone once the user edited the very
        // sentence being revised. That is the conflict case the user must be
        // told about, not "the region is ambiguous", and the user's text wins.
        expect(result.message).toMatch(/changed/i);
        expect(useDocumentStore.getState().content).toBe(edited);
      });

      describe("re-validation against the browser's document (T057, FR-019)", () => {
        it("refuses a revision whose target region already changed, keeping the user's text", () => {
          loadScript(FIRST_DRAFT.replacementText);
          // The user edits the very sentence the AI was asked to change, while
          // the request is still in flight.
          const edited = FIRST_DRAFT.replacementText.replace(
            "the networks fell.",
            "the networks fell, slowly at first.",
          );
          apply(edited);

          const result = apply(TARGETED);

          expect(result.applied).toBe(false);
          expect(result.message).toMatch(/changed/i);
          expect(useDocumentStore.getState().content).toBe(edited);
        });

        it("does not overwrite text the user typed outside the target region", () => {
          loadScript(FIRST_DRAFT.replacementText);
          const withFooter = `${FIRST_DRAFT.replacementText}\n\nA footnote added by the author.`;
          apply(withFooter);

          const result = apply(TARGETED);

          expect(result.applied).toBe(true);
          expect(useDocumentStore.getState().content).toBe(
            "# The Bronze Age\n\nAround 1200 BCE, the networks collapsed.\n\nA footnote added by the author.",
          );
        });

        it("refuses a first draft arriving after the user started typing", () => {
          loadScript();
          apply("The author typed this first.");

          const result = apply(FIRST_DRAFT);

          expect(result.applied).toBe(false);
          expect(useDocumentStore.getState().content).toBe(
            "The author typed this first.",
          );
        });

        it("applies the same revision only when its text is exactly the region's text", () => {
          // Whitespace matters: the anchor text with an extra space is not the
          // region's text, so the revision is stale even though it reads the same.
          loadScript(FIRST_DRAFT.replacementText);
          const spaced = FIRST_DRAFT.replacementText.replace(
            "the networks fell.",
            "the  networks fell.",
          );
          apply(spaced);

          const spacedResult = apply(TARGETED);

          expect(spacedResult.applied).toBe(false);
          expect(useDocumentStore.getState().content).toBe(spaced);
        });
      });

      it("marks a save as under way, so the change is not left unsaved", () => {
        loadScript(FIRST_DRAFT.replacementText);

        apply(TARGETED);

        expect(useDocumentStore.getState().saveState).toBe("saving");
      });
    });

    describe("a manual edit", () => {
      it("replaces the document and marks a save as under way", () => {
        loadScript("Before.");

        const result = apply("After.");

        expect(result).toEqual({ applied: true });
        expect(useDocumentStore.getState()).toMatchObject({
          content: "After.",
          saveState: "saving",
        });
        expect(selectIsDirty(useDocumentStore.getState())).toBe(true);
      });

      it("treats an identical edit as no change, without starting a save", () => {
        loadScript("Same.");

        const result = apply("Same.");

        expect(result).toEqual({ applied: true });
        expect(useDocumentStore.getState().saveState).toBe("saved");
      });
    });

    it("refuses any proposal when no script is open", () => {
      expect(apply("Text.")).toMatchObject({ applied: false });
      expect(apply(FIRST_DRAFT)).toMatchObject({ applied: false });
      expect(useDocumentStore.getState().content).toBe("");
    });

    it("never throws: every outcome is a typed result", () => {
      loadScript(FIRST_DRAFT.replacementText);

      const ambiguous: PendingRevision = {
        ...TARGETED,
        targetRegion: { type: "anchor", anchorText: "e" },
        expectedText: "e",
      };

      expect(() => apply(ambiguous)).not.toThrow();
      expect(apply(ambiguous)).toMatchObject({ applied: false });
    });

    /**
     * `saveContent` is the store's half of persistence: the autosave
     * scheduler calls it, and the switch-away prompt awaits it. It rejects
     * rather than returning a value, so every caller can report the failure
     * (FR-005) — never a silent one.
     */
    describe("a save", () => {
      it("sends the precondition the client last saw with the text", async () => {
        loadScript("Persisted.");

        await useDocumentStore.getState().saveContent("Changed.");

        expect(saveScriptContent).toHaveBeenCalledWith(SCRIPT_ID, {
          content: "Changed.",
          baseUpdatedAt: UPDATED_AT,
        });
      });

      it("records only the new precondition, leaving newer text unsaved", async () => {
        loadScript("Persisted.");
        useDocumentStore.getState().applyProposal("First edit.");
        useDocumentStore.getState().applyProposal("Second edit, still unsaved.");

        await useDocumentStore.getState().saveContent("First edit.");

        const state = useDocumentStore.getState();

        expect(state.persistedContent).toBe("First edit.");
        expect(state.content).toBe("Second edit, still unsaved.");
        expect(state.updatedAt).toBe("saved-11");
        expect(selectIsDirty(state)).toBe(true);
      });

      it("refuses to save with no script open", async () => {
        await expect(useDocumentStore.getState().saveContent("Text.")).rejects.toThrow(
          /No script is open/,
        );
        expect(saveScriptContent).not.toHaveBeenCalled();
      });

      it("refuses to save before the script has loaded", async () => {
        useDocumentStore.setState({ scriptId: SCRIPT_ID, updatedAt: null });

        await expect(useDocumentStore.getState().saveContent("Text.")).rejects.toThrow(
          /not been loaded/,
        );
        expect(saveScriptContent).not.toHaveBeenCalled();
      });

      it("rejects with the server's code, so the UI can name the cause (FR-022a)", async () => {
        loadScript("Persisted.");
        saveScriptContent.mockImplementation(async () => ({
          ok: false,
          error: { code: "stale_write", message: "The script changed elsewhere." },
        }));

        const failure = await useDocumentStore
          .getState()
          .saveContent("Changed.")
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(SaveError);
        expect(failure).toMatchObject({
          code: "stale_write",
          message: "The script changed elsewhere.",
        });
      });
    });
  });
});
