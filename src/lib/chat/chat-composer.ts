/**
 * The chat composer's rules while an answer is streaming (FR-014a, FR-014b).
 *
 * Pure functions, so the rules are asserted without a renderer: which control
 * the panel offers, when a streamed tool call may reach the document, and what
 * survives a stop. The panel and the applied-revisions hook read them, which is
 * what keeps "send" and "stop" from ever being offered at the same time.
 */

/** What the prompt's primary control is, and whether it can be used. */
export type ComposerControl =
  { readonly kind: "stop" } | { readonly kind: "send"; readonly disabled: boolean };

export interface ComposerState {
  readonly streaming: boolean;
  readonly hasText: boolean;
  readonly ready: boolean;
}

export function composerControl({
  streaming,
  hasText,
  ready,
}: ComposerState): ComposerControl {
  // While a response streams the control is the stop button: there is no way
  // to send a second concurrent request for the script (FR-014a).
  if (streaming) {
    return { kind: "stop" };
  }

  return { kind: "send", disabled: !ready || !hasText };
}

/** Whether a tool part is a change that may be written to the document. */
export type ProposalApplication = "apply" | "none";

/**
 * A tool part reaches the document only as a settled, applied result.
 *
 * Everything earlier in a tool call's life — the arguments still streaming in,
 * the call waiting for an answer, an error, a refusal — is "none": a partial
 * revision is never written, so stopping mid-stream can never leave one
 * persisted (FR-014b).
 */
export function proposalApplication(part: {
  readonly type: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly output?: unknown;
}): ProposalApplication {
  if (!part.type.startsWith("tool-") || part.state !== "output-available") {
    return "none";
  }

  const output = part.output;

  return typeof output === "object" &&
    output !== null &&
    "applied" in output &&
    (output as { applied: unknown }).applied === true
    ? "apply"
    : "none";
}

/** One revision's state, for the stop rule below. */
export interface RevisionProgress {
  readonly id: string;
  readonly state: "applied" | "streaming";
}

/**
 * What was applied when the user stopped an answer.
 *
 * Stopping ends the response immediately (FR-014b). A revision already applied
 * stays applied, because it is already in the document; the one in flight when
 * the stop arrived is not among them, because it never settled.
 */
export function requestAfterStop({
  applied,
  inFlight,
}: {
  readonly applied: readonly RevisionProgress[];
  readonly inFlight: RevisionProgress | null;
}): readonly RevisionProgress[] {
  return inFlight === null
    ? applied
    : applied.filter((revision) => revision.id !== inFlight.id);
}
