// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardRecoveryCopy,
  offerRecoveryCopy,
  readRecoveryCopy,
  recoveryCopyKey,
  takeRecoveryCopy,
} from "@/lib/editor/recovery-copy";

/**
 * The local copy of text a failed save left unsaved (FR-005b, SC-005).
 *
 * Autosave makes every write durable, which makes a failed one the only place
 * text can be lost. When a save has failed and the workspace is left, the
 * text is kept in the browser for that script, and the next time the script is
 * opened the user chooses: restore it or discard it. Either answer ends the
 * offer, so a stale copy is never offered twice.
 */

const SCRIPT_ID = "3f2f1c1e-2222-4222-8222-222222222222";
const OTHER_SCRIPT_ID = "8d1c0f7a-3333-4333-8333-333333333333";
const SAVED_CONTENT = "# Draft\n\nSaved.";
const UNSAVED = "# Draft\n\nSaved, then edited while offline.";
const SAVED_AT = "2026-10-17T10:00:00.000Z";
const CAPTURED_AT = "2026-10-17T10:05:00.000Z";

beforeEach(() => {
  localStorage.clear();
});

describe("recoveryCopyKey", () => {
  it("names the copy by script, so one script's text can never be another's", () => {
    expect(recoveryCopyKey(SCRIPT_ID)).not.toBe(recoveryCopyKey(OTHER_SCRIPT_ID));
    expect(recoveryCopyKey(SCRIPT_ID)).toContain(SCRIPT_ID);
  });
});

describe("offerRecoveryCopy", () => {
  it("keeps the text that was not saved, with where it belongs", () => {
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: UNSAVED,
      savedContent: SAVED_CONTENT,
      savedUpdatedAt: SAVED_AT,
      capturedAt: CAPTURED_AT,
    });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toMatchObject({
      scriptId: SCRIPT_ID,
      content: UNSAVED,
      savedContent: SAVED_CONTENT,
      savedUpdatedAt: SAVED_AT,
      capturedAt: CAPTURED_AT,
    });
  });

  it("keeps the newest failed text, not a copy an earlier failure left", () => {
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: "First attempt.",
      savedContent: SAVED_CONTENT,
    });
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: "The latest text.",
      savedContent: SAVED_CONTENT,
    });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })?.content).toBe("The latest text.");
  });

  it("keeps nothing when the text was never out of step with the server", () => {
    // The editor already holds this text, and the server acknowledged it:
    // restoring it would be a no-op, and offering it is noise.
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: SAVED_CONTENT,
      savedContent: SAVED_CONTENT,
    });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("adapts when the browser refuses to store anything", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    try {
      expect(() =>
        offerRecoveryCopy({
          scriptId: SCRIPT_ID,
          content: UNSAVED,
          savedContent: SAVED_CONTENT,
        }),
      ).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("reading the copy back", () => {
  it("offers nothing for a script that has none", () => {
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("offers nothing for a stored value that is not a copy", () => {
    localStorage.setItem(recoveryCopyKey(SCRIPT_ID), "not json");
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();

    localStorage.setItem(recoveryCopyKey(SCRIPT_ID), JSON.stringify({ content: 7 }));
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("offers nothing for another script's copy", () => {
    offerRecoveryCopy({
      scriptId: OTHER_SCRIPT_ID,
      content: UNSAVED,
      savedContent: SAVED_CONTENT,
    });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });
});

describe("answering the offer", () => {
  it("restoring hands back the text and ends the offer", () => {
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: UNSAVED,
      savedContent: SAVED_CONTENT,
    });

    expect(takeRecoveryCopy({ scriptId: SCRIPT_ID })).toMatchObject({
      content: UNSAVED,
    });
    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("discarding drops the text and ends the offer", () => {
    offerRecoveryCopy({
      scriptId: SCRIPT_ID,
      content: UNSAVED,
      savedContent: SAVED_CONTENT,
    });

    discardRecoveryCopy({ scriptId: SCRIPT_ID });

    expect(readRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
    expect(takeRecoveryCopy({ scriptId: SCRIPT_ID })).toBeNull();
  });

  it("restoring one script's copy leaves another script's untouched", () => {
    offerRecoveryCopy({ scriptId: SCRIPT_ID, content: "Mine.", savedContent: "" });
    offerRecoveryCopy({
      scriptId: OTHER_SCRIPT_ID,
      content: "Theirs.",
      savedContent: "",
    });

    takeRecoveryCopy({ scriptId: SCRIPT_ID });

    expect(readRecoveryCopy({ scriptId: OTHER_SCRIPT_ID })?.content).toBe("Theirs.");
  });
});
