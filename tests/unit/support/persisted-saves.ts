/**
 * Keeps store tests off the network.
 *
 * Any state transition the store considers a change starts a save, so a test
 * that drives the store directly (rather than through the autosave hook) would
 * otherwise reach `fetch` and leave an unhandled rejection behind. Vitest
 * reports those as run-level errors, and a run with errors must never pass the
 * coverage gate — an unhandled rejection can hide a false positive.
 *
 * The result here is what the real endpoint returns when the script is open
 * and its `updatedAt` is current, which is the precondition every such test
 * holds. A test that needs a failing save mocks the module itself; a test that
 * needs a real-looking `updatedAt` can pass one.
 */

export interface AcceptedSave {
  readonly ok: true;
  readonly data: {
    readonly id: string;
    readonly content: string;
    readonly updatedAt: string;
  };
}

export function acceptedSave(
  scriptId: string,
  body?: { content?: string },
): AcceptedSave {
  const content = body?.content ?? "";

  return {
    ok: true,
    data: { id: scriptId, content, updatedAt: `saved-${content.length}` },
  };
}
