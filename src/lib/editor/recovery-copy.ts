/**
 * The local copy of text a failed save left unsaved (FR-005b, SC-005).
 *
 * Autosave writes every change, so a save that fails is the one place text can
 * be lost: the editor holds it, the server never received it, and closing the
 * workspace would take it away. When a save has failed, the text is kept in the
 * browser under that script's key, and the next time the script is opened the
 * user chooses between restoring it and discarding it — never both silently.
 *
 * One key per script, so a copy can only ever be offered to the script it came
 * from (FR-006). Storage is the browser's: a private window, a full disk, or a
 * user who disabled storage all make `setItem` throw, and none of them may turn
 * a failed save into a crash on top of it.
 */

import type { IsoTimestamp, ScriptId } from "@/lib/domain/types";

/** Text the server never acknowledged, held until the user decides. */
export interface StoredRecoveryCopy {
  readonly scriptId: ScriptId;
  /** What the user had, which the server does not. */
  readonly content: string;
  /** What the server did have when the copy was taken. */
  readonly savedContent: string;
  /** The `updatedAt` of `savedContent`; the base a restore's save must use. */
  readonly savedUpdatedAt: IsoTimestamp | null;
  readonly capturedAt: IsoTimestamp;
}

export type RecoveryCopyInput = Omit<
  StoredRecoveryCopy,
  "savedUpdatedAt" | "capturedAt"
> &
  Partial<Pick<StoredRecoveryCopy, "savedUpdatedAt" | "capturedAt">>;

/** The browser-storage key for one script's copy. */
export function recoveryCopyKey(scriptId: ScriptId): string {
  return `narrative-engine:recovery-copy:${scriptId}`;
}

/**
 * Keeps the text a failed save left behind, replacing any earlier copy — the
 * newest failed text is the one worth offering. A copy whose text the server
 * already has is not kept: restoring it would change nothing.
 *
 * Never throws; a browser that refuses storage simply keeps no copy.
 */
export function offerRecoveryCopy(input: RecoveryCopyInput): void {
  if (input.content === input.savedContent) {
    discardRecoveryCopy(input);

    return;
  }

  const copy: StoredRecoveryCopy = {
    scriptId: input.scriptId,
    content: input.content,
    savedContent: input.savedContent,
    savedUpdatedAt: input.savedUpdatedAt ?? null,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };

  try {
    storage()?.setItem(recoveryCopyKey(input.scriptId), JSON.stringify(copy));
  } catch {
    // No storage, no copy: the editor still holds the text, and the save
    // indicator still says it is not saved (FR-005).
  }
}

/** The copy waiting for this script, if there is one. Never throws. */
export function readRecoveryCopy({
  scriptId,
}: {
  readonly scriptId: ScriptId;
}): StoredRecoveryCopy | null {
  let stored: string | null = null;

  try {
    stored = storage()?.getItem(recoveryCopyKey(scriptId)) ?? null;
  } catch {
    return null;
  }

  if (stored === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(stored);

    return isRecoveryCopy(parsed) && parsed.scriptId === scriptId ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The user chose to restore: hands the copy back and ends the offer, so it is
 * not offered again on the next open.
 */
export function takeRecoveryCopy({
  scriptId,
}: {
  readonly scriptId: ScriptId;
}): StoredRecoveryCopy | null {
  const copy = readRecoveryCopy({ scriptId });

  discardRecoveryCopy({ scriptId });

  return copy;
}

/** The user declined, or the copy no longer applies: it is dropped. */
export function discardRecoveryCopy({ scriptId }: { readonly scriptId: ScriptId }): void {
  try {
    storage()?.removeItem(recoveryCopyKey(scriptId));
  } catch {
    // Nothing to do: a copy that cannot be removed is still safe to offer.
  }
}

/** The browser's local storage, or nothing where there is no browser. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecoveryCopy(value: unknown): value is StoredRecoveryCopy {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const copy = value as Record<string, unknown>;

  return (
    typeof copy.scriptId === "string" &&
    typeof copy.content === "string" &&
    typeof copy.savedContent === "string" &&
    (copy.savedUpdatedAt === null || typeof copy.savedUpdatedAt === "string") &&
    typeof copy.capturedAt === "string"
  );
}
