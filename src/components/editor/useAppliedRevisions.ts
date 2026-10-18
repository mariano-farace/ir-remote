"use client";

/**
 * Applies the assistant's revisions to the document (T039).
 *
 * A tool part becomes applicable when it reaches `output-available` and
 * carries an applied revision. Each `toolCallId` is applied at most once —
 * React re-renders, and a stream can be replayed — and only through
 * `applyProposal`, the single write path (Principle III). `onToolCall` is
 * deliberately not used: it is for client-executed tools, and a second
 * application of the same revision could corrupt a targeted edit.
 *
 * The store re-validates the revision against the browser's document, so if the
 * user typed into the target region while the request was in flight the change
 * is refused and the typed text survives (FR-015b).
 *
 * A change that would clear the script is never applied from here (FR-021).
 * The server asks first (`approval-requested`), and that part becomes the
 * question in the store; a revision the store itself finds would clear the
 * document becomes the same question. Only the user's answer writes, through
 * the store's `confirmClear`, which runs the revision with their consent.
 */

import { useEffect, useRef } from "react";

import type { RevisionToolPart } from "@/components/chat/tool-parts";
import type { PendingRevision } from "@/lib/domain/types";
import { useDocumentStore } from "@/stores/document-store";

/** The one tool that writes the document. */
const REVISION_TOOL_PART_TYPE = "tool-apply_document_revision";

/** A tool part as far as this hook reads it. */
interface AppliedPart extends RevisionToolPart {
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly output?: { readonly applied?: unknown; readonly revision?: unknown } | unknown;
}

function pendingRevision(part: AppliedPart): PendingRevision | null {
  const output = part.output as
    { readonly applied?: unknown; readonly revision?: PendingRevision } | undefined;

  if (output?.applied !== true || !output.revision) {
    return null;
  }

  return output.revision;
}

/** The revision a request-for-approval part describes. */
function requestedRevision(part: AppliedPart): PendingRevision | null {
  const input = part.input as
    | {
        readonly targetRegion?: { readonly anchorText?: unknown };
        readonly expectedText?: unknown;
        readonly replacementText?: unknown;
        readonly summary?: unknown;
      }
    | null
    | undefined;

  if (
    !input ||
    typeof input.expectedText !== "string" ||
    typeof input.replacementText !== "string" ||
    typeof input.summary !== "string"
  ) {
    return null;
  }

  const anchorText = input.targetRegion?.anchorText;

  return {
    targetRegion:
      typeof anchorText === "string"
        ? { type: "anchor", anchorText }
        : { type: "whole-document" },
    expectedText: input.expectedText,
    replacementText: input.replacementText,
    kind: typeof anchorText === "string" ? "targeted" : "wholesale-rewrite",
    summary: input.summary,
  };
}

export function useAppliedRevisions(
  parts: readonly ({ readonly type: string } & Partial<RevisionToolPart>)[],
): void {
  const applied = useRef(new Set<string>());

  useEffect(() => {
    for (const raw of parts) {
      const part = raw as AppliedPart;

      if (part.type !== REVISION_TOOL_PART_TYPE || !part.toolCallId) {
        continue;
      }

      if (part.state === "approval-requested") {
        const revision = requestedRevision(part);

        if (revision !== null && part.approval) {
          if (part.approval.reason === "rewrite") {
            // A full rewrite is permitted only when the user confirms it
            // (FR-015c, second case). Until they answer, nothing is written.
            useDocumentStore.getState().requestRewriteConfirmation({
              toolCallId: part.toolCallId,
              approvalId: part.approval.id,
              revision,
              summary: revision.summary,
            });
          } else {
            useDocumentStore.getState().requestClearConfirmation({
              toolCallId: part.toolCallId,
              approvalId: part.approval.id,
              revision,
            });
          }
        }

        continue;
      }

      if (part.state !== "output-available" || applied.current.has(part.toolCallId)) {
        continue;
      }

      const revision = pendingRevision(part);

      if (revision === null) {
        continue;
      }

      // A cleared script is the user's decision, not a result to apply behind
      // their back; the question only exists if the server asked it.
      if (part.approval?.approved === false) {
        applied.current.add(part.toolCallId);
        continue;
      }

      // The user's yes to a rewrite question is the consent FR-015c requires;
      // the server applied it for the same reason, and the browser re-runs the
      // same rule against the document in front of the user.
      const approvedRewrite =
        part.approval?.approved === true && part.approval.reason === "rewrite";

      const result = useDocumentStore
        .getState()
        .applyProposal(revision, { rewriteConfirmed: approvedRewrite });

      if (result.needsClearConfirmation) {
        // The document changed under the request, so the store — not the
        // server — is asking. Nothing is applied until the user answers.
        useDocumentStore.getState().requestClearConfirmation({
          toolCallId: part.toolCallId,
          approvalId: part.approval?.id ?? "",
          revision,
        });
        continue;
      }

      applied.current.add(part.toolCallId);
    }
  }, [parts]);
}
