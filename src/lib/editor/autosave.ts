/**
 * Autosave scheduling (FR-004, FR-005): the debounce and the single-flight loop,
 * with no React in this file.
 *
 * Pulled out of the hook so the scheduling rules — which are exactly the ones
 * a user feels — can be tested with fake timers and no renderer:
 *
 *  - a trailing debounce coalesces a burst of edits into one save;
 *  - at most one save is in flight, ever;
 *  - an edit made while a save is running is saved after it resolves, because
 *    the dirty check runs again *after* each save, against the latest state;
 *  - the final edit is never lost to a save that was already scheduled.
 *
 * "Unsaved" is defined as the editor's text differing from the text the server
 * last confirmed, rather than as a flag some code path remembers to set. A flag
 * is one missed call away from silently never saving; a comparison can only be
 * wrong if the text itself is.
 */

/** How long a burst of edits is allowed to settle before a save starts. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * How long to wait before each retry of a failed save (FR-005a): three
 * attempts, each after a longer pause. A server that is briefly unreachable
 * usually recovers within a few seconds, so this is long enough to outlast a
 * blip and short enough that the user is not left watching "Retrying…".
 */
export const AUTOSAVE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

export interface AutosaveRequest {
  /** The document as it is now. */
  readonly content: string;
  /** The text the server last confirmed; saved only if it differs from `content`. */
  readonly persistedContent: string;
}

export interface AutosaveSchedulerOptions {
  /**
   * Persists `request.content`, where `request.persistedContent` is the text
   * the server held when the save started — the precondition the endpoint
   * checks against. Resolves when the save is acknowledged; rejects on failure.
   */
  persist(request: AutosaveRequest): Promise<void>;
  /** Reads the latest state. Called when a save starts, so it is never stale. */
  read(): AutosaveRequest;
  /** Called after every save attempt settles, so the UI can show its state. */
  onChange?(event: AutosaveOutcome): void;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
}

/** A save the server refused because its base is out of date (FR-019). */
function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "stale_write"
  );
}

export type AutosaveOutcome =
  | { readonly kind: "saving" }
  | { readonly kind: "retrying" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly error: unknown };

type AttemptResult =
  | { readonly saved: true }
  /** `needsUser` is a conflict: the same base would fail again, so retrying is pointless. */
  | { readonly saved: false; readonly needsUser: boolean };

export interface AutosaveScheduler {
  /** Reports that the document changed; (re)starts the debounce. */
  scheduleEdit(): void;
  /**
   * Ends the scheduler. A pending debounce is cancelled; a save already in
   * flight is left to finish, because cancelling it would leave the server in
   * a state the local text no longer describes.
   */
  stop(): void;
  /** Saves any pending change immediately, without waiting for the debounce. */
  flush(): Promise<void>;
  /** True while a save is in flight. */
  isSaving(): boolean;
}

export function createAutosaveScheduler({
  persist,
  read,
  onChange,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  retryDelaysMs = AUTOSAVE_RETRY_DELAYS_MS,
}: AutosaveSchedulerOptions): AutosaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopped = false;
  /** Set by an unrecoverable failure; a later edit does not resurrect the loop. */
  let failed = false;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Attempts the save in hand, retrying a failed attempt up to
   * `retryDelaysMs.length` times. Resolves `true` when the server acknowledged
   * the text, `false` when every attempt failed or the failure is one a retry
   * cannot fix.
   */
  async function attempt(request: AutosaveRequest): Promise<AttemptResult> {
    let failures = 0;

    for (;;) {
      try {
        await persist(request);
        onChange?.({ kind: "saved" });

        return { saved: true };
      } catch (error) {
        // A conflict is refused because the base is stale; the same base fails
        // again every time, so the user has to resolve it, not the loop.
        if (isConflict(error) || failures >= retryDelaysMs.length) {
          onChange?.({ kind: "failed", error });

          return { saved: false, needsUser: isConflict(error) };
        }

        const delay = retryDelaysMs[failures] ?? 0;

        failures += 1;
        onChange?.({ kind: "retrying" });

        await sleep(delay);

        if (stopped) {
          onChange?.({ kind: "failed", error });

          return { saved: false, needsUser: false };
        }
      }
    }
  }

  /**
   * One turn of the loop. Re-reads state, saves only if something is unsaved,
   * and when the save settles starts a further turn if the edit that landed
   * meanwhile left anything unsaved.
   */
  async function turn(): Promise<void> {
    if (inFlight) {
      return;
    }

    const before = read();

    if (before.content === before.persistedContent) {
      return;
    }

    inFlight = true;
    onChange?.({ kind: "saving" });

    const result = await attempt(before);

    inFlight = false;

    if (!result.saved) {
      // Unsaved text stays as it is: `content` is never rewritten here, so the
      // editor keeps exactly what the user typed.
      if (result.needsUser) {
        failed = true;
      }

      return;
    }

    const after = read();

    if (!stopped && !failed && after.content !== after.persistedContent) {
      // An edit arrived during the save. Save it now rather than on a fresh
      // debounce: the user has already stopped typing once.
      await run();
    }
  }

  function run(): Promise<void> {
    return failed ? Promise.resolve() : turn();
  }

  function scheduleEdit(): void {
    if (stopped || failed) {
      return;
    }

    if (inFlight) {
      // The loop re-checks for unsaved text when the save resolves, so
      // nothing needs to be scheduled now; the edit is not lost.
      return;
    }

    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    clearTimer();
    await run();
  }

  return {
    scheduleEdit,
    stop() {
      stopped = true;
      clearTimer();
    },
    flush,
    isSaving() {
      return inFlight;
    },
  };
}
