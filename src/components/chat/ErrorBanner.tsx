"use client";

/**
 * Distinguishable failure messages for the chat (FR-022, FR-022a).
 *
 * A failed AI turn is not one kind of failure. "The model took too long",
 * "the provider is failing", "the model answered with something unusable" and
 * "you edited the paragraph it was changing" call for different reactions from
 * the user, so each has its own code and its own sentence. Collapsing them into
 * one "something went wrong" would hide the only case the user can act on
 * quickly — the conflict, where their own edit is the reason.
 *
 * A message the server supplied is shown as given: the server owns the wording,
 * and this component never invents copy over it. It renders as text, never as
 * markup, so model- or upstream-derived text cannot execute (Principle IV).
 */

export type FailureCause = "timeout" | "upstream" | "invalid_output" | "conflict";

export interface Failure {
  readonly cause: FailureCause;
  /** The server's message, when one came back; otherwise the cause's own copy. */
  readonly message?: string;
}

interface FailureCopy {
  readonly code: string;
  readonly message: string;
}

const FAILURE_COPY: Record<FailureCause, FailureCopy> = {
  timeout: {
    code: "assistant_timeout",
    message:
      "The assistant took too long to answer. Your script is unchanged; try again, or shorten the request.",
  },
  upstream: {
    code: "assistant_upstream_failure",
    message:
      "The assistant could not be reached. Your script is unchanged; try again in a moment.",
  },
  invalid_output: {
    code: "assistant_invalid_output",
    message:
      "The assistant's answer could not be used, so nothing was changed. Try asking again, perhaps more specifically.",
  },
  conflict: {
    code: "document_conflict",
    message:
      "The script changed while the assistant was working on it, so the change was not applied. Your text is kept; ask again to retry against the current version.",
  },
};

/** The code and user-facing sentence for a cause. */
export function describeFailure(cause: FailureCause): FailureCopy {
  return FAILURE_COPY[cause];
}

export function ErrorBanner({ failure }: { readonly failure: Failure | null }) {
  if (failure === null) {
    return null;
  }

  const copy = describeFailure(failure.cause);

  return (
    <p
      role="alert"
      data-error-code={copy.code}
      className="px-4 pb-2 text-sm text-red-700"
    >
      {failure.message && failure.message.trim() !== "" ? failure.message : copy.message}
    </p>
  );
}
