import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_RETRY_DELAYS_MS,
  createAutosaveScheduler,
  type AutosaveOutcome,
} from "@/lib/editor/autosave";

/**
 * FR-005a: a failed save is retried exactly three times with increasing delay
 * before it is reported as failed.
 *
 * The state sequence matters as much as the count: the user must be able to
 * tell "working" from "failing, trying again" from "given up", and the editor's
 * text must never be the thing that pays for a failed save.
 */

function createHarness(failures: number) {
  let content = "Original.";
  let persistedContent = "Original.";
  let attempts = 0;
  const attemptsAt: number[] = [];
  const outcomes: AutosaveOutcome[] = [];
  const startedAt = 0;
  let now = startedAt;

  vi.setSystemTime(startedAt);

  const scheduler = createAutosaveScheduler({
    read: () => ({ content, persistedContent }),
    persist: async (request) => {
      attempts += 1;
      attemptsAt.push(now - startedAt);

      if (attempts <= failures) {
        throw new Error(`attempt ${attempts} failed`);
      }

      persistedContent = request.content;
    },
    onChange: (event) => outcomes.push(event),
  });

  return {
    scheduler,
    outcomes,
    attempts: () => attempts,
    attemptsAt,
    content: () => content,
    persisted: () => persistedContent,
    edit(next: string) {
      content = next;
      scheduler.scheduleEdit();
    },
    /** Moves the fake clock and timers forward together. */
    async advance(ms: number) {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    /** Lets the save's promise callbacks run without moving the clock. */
    async settle() {
      for (let turn = 0; turn < 10; turn += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
    },
    outcomeKinds: () => outcomes.map((event) => event.kind),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("autosave retries (FR-005a)", () => {
  it("uses three increasing retry delays", () => {
    expect(AUTOSAVE_RETRY_DELAYS_MS).toHaveLength(3);

    for (let index = 1; index < AUTOSAVE_RETRY_DELAYS_MS.length; index += 1) {
      expect(AUTOSAVE_RETRY_DELAYS_MS[index]).toBeGreaterThan(
        AUTOSAVE_RETRY_DELAYS_MS[index - 1] ?? 0,
      );
    }
  });

  it("retries exactly three times, then reports failure", async () => {
    const harness = createHarness(Number.POSITIVE_INFINITY);

    harness.edit("Edited.");
    await harness.advance(AUTOSAVE_DEBOUNCE_MS);
    await harness.settle();

    // Each retry waits its own delay before trying again.
    for (const delay of AUTOSAVE_RETRY_DELAYS_MS) {
      await harness.advance(delay);
      await harness.settle();
    }

    // One initial attempt plus three retries: no more.
    expect(harness.attempts()).toBe(1 + AUTOSAVE_RETRY_DELAYS_MS.length);
    expect(harness.outcomeKinds().at(-1)).toBe("failed");

    // And it stays failed: nothing retries behind the user's back afterwards.
    await harness.advance(AUTOSAVE_DEBOUNCE_MS * 10);
    expect(harness.attempts()).toBe(1 + AUTOSAVE_RETRY_DELAYS_MS.length);
  });

  it("waits longer before each retry", async () => {
    const harness = createHarness(Number.POSITIVE_INFINITY);

    harness.edit("Edited.");
    await harness.advance(AUTOSAVE_DEBOUNCE_MS);
    await harness.settle();

    for (const delay of AUTOSAVE_RETRY_DELAYS_MS) {
      await harness.advance(delay);
      await harness.settle();
    }

    const gaps = harness.attemptsAt.slice(1).map((at, index) => {
      const previous = harness.attemptsAt[index] ?? 0;

      return at - previous;
    });

    // Each gap is at least the configured delay (time only moves forward), and
    // strictly longer than the one before it.
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(AUTOSAVE_RETRY_DELAYS_MS[index] ?? 0);

      if (index > 0) {
        expect(gap).toBeGreaterThan(gaps[index - 1] ?? 0);
      }
    });
  });

  it("passes through retrying, not straight from saving to saved or failed", async () => {
    const harness = createHarness(1);

    harness.edit("Edited.");
    await harness.advance(AUTOSAVE_DEBOUNCE_MS);
    await harness.settle();

    expect(harness.outcomeKinds()).toEqual(["saving", "retrying"]);

    await harness.advance(AUTOSAVE_RETRY_DELAYS_MS[0] ?? 0);
    await harness.settle();

    expect(harness.outcomes.at(-1)).toEqual({ kind: "saved" });
  });

  it("reports a save that succeeds on the third attempt as saved", async () => {
    const harness = createHarness(2);

    harness.edit("Edited.");
    await harness.advance(AUTOSAVE_DEBOUNCE_MS);
    await harness.settle();

    for (const delay of AUTOSAVE_RETRY_DELAYS_MS) {
      await harness.advance(delay);
      await harness.settle();
    }

    expect(harness.attempts()).toBe(3);
    expect(harness.outcomes.at(-1)).toEqual({ kind: "saved" });
    expect(harness.persisted()).toBe("Edited.");
  });

  it("keeps the text in the editor when every attempt fails (FR-005)", async () => {
    const harness = createHarness(Number.POSITIVE_INFINITY);

    harness.edit("Edited and not saved.");
    await harness.advance(AUTOSAVE_DEBOUNCE_MS);
    await harness.settle();

    for (const delay of AUTOSAVE_RETRY_DELAYS_MS) {
      await harness.advance(delay);
      await harness.settle();
    }

    expect(harness.outcomeKinds().at(-1)).toBe("failed");
    expect(harness.content()).toBe("Edited and not saved.");
    // The server never acknowledged it, so the document still knows it is unsaved.
    expect(harness.persisted()).toBe("Original.");
  });

  it("does not retry a conflict: the base is wrong and would stay wrong", async () => {
    let attempts = 0;
    const outcomes: AutosaveOutcome[] = [];
    const scheduler = createAutosaveScheduler({
      read: () => ({ content: "Mine.", persistedContent: "Theirs." }),
      persist: async () => {
        attempts += 1;
        throw Object.assign(new Error("stale"), { code: "stale_write" });
      },
      onChange: (event) => outcomes.push(event),
    });

    scheduler.scheduleEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    for (const delay of AUTOSAVE_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(attempts).toBe(1);
    expect(outcomes.at(-1)).toMatchObject({ kind: "failed" });
  });
});
