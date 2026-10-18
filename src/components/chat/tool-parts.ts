/**
 * Reading the assistant's tool parts in the chat (contracts/tool-call.md).
 *
 * Kept apart from the panel so the mapping from a streamed part to a line of
 * English is testable without rendering React. An assistant turn's visible
 * output is at most a one-sentence summary of the change or the reason it was
 * refused — never the document (FR-016, SC-002).
 */

import type { DocumentRevisionResult } from "@/lib/ai/tools";

/** The fields of a tool UI part this module reads, independent of SDK generics. */
export interface RevisionToolPart {
  readonly type: string;
  readonly state?: string;
  readonly output?: unknown;
  readonly errorText?: string;
  /**
   * Present on `approval-requested` and `approval-responded` parts. `reason`
   * names which question was asked — the clear guard or a full rewrite.
   */
  readonly approval?: {
    readonly id: string;
    readonly approved?: boolean;
    readonly reason?: string;
  };
}

/** The user's answer to an approval request, as `useChat` expects it. */
export interface ToolApprovalResponse {
  readonly id: string;
  readonly approved: boolean;
  readonly reason?: string;
}

function isResult(value: unknown): value is DocumentRevisionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "applied" in value &&
    typeof (value as { applied: unknown }).applied === "boolean"
  );
}

/**
 * The line the chat shows for one tool part, or `null` while it has nothing
 * to say yet (`input-streaming`, `input-available`: the change is not settled;
 * an approved answer: the revision is about to arrive as a result).
 */
export function describeToolPart(
  part: { readonly type: string } & Partial<RevisionToolPart>,
): string | null {
  if (part.state === "output-error") {
    return part.errorText || "The assistant's change could not be applied.";
  }

  // The two questions the server can hold a call for, each named as itself:
  // the anti-clear guard (FR-021) and the explicit rewrite (FR-015c). The
  // server's approval request and the decline the SDK reports when it sees one
  // (`output-denied`) are both read; which one arrives depends on the SDK
  // version, and neither may be silent.
  if (part.state === "approval-requested" || part.state === "approval-responded") {
    return part.approval?.reason === "rewrite"
      ? "This change would rewrite the whole script. Confirm it in the editor, or cancel to keep the text."
      : "This change would clear the script. Confirm it in the editor, or cancel to keep the text.";
  }

  if (part.state === "output-denied") {
    return "The change was not applied because you declined it.";
  }

  if (part.state !== "output-available" || !isResult(part.output)) {
    return null;
  }

  const result: DocumentRevisionResult = part.output;

  return result.applied ? result.summary : result.message;
}
