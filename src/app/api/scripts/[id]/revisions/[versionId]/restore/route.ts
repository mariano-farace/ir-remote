/**
 * `/api/scripts/{id}/revisions/{versionId}/restore` — undo (contracts/http-api.md).
 *
 *   POST → replace the document with a prior version (FR-020, FR-021)
 *
 * The restore goes through the same revision-first write as autosave: the
 * content it replaces becomes a new version before the older one lands, so an
 * undo is itself undoable. A version belonging to another script is reported as
 * not found, never restored across scripts (FR-006).
 *
 * The restore takes no `baseUpdatedAt`. It is the user choosing the document
 * they want from the history the current content produced, so there is no
 * competing client text to reconcile; the fetch-and-write under the row lock
 * makes the choice atomic.
 */

import { NextResponse } from "next/server";

import { dataResponse, errorResponse } from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError } from "@/lib/repositories/types";

export async function POST(
  _request: Request,
  context: {
    readonly params: Promise<{ readonly id: string; readonly versionId: string }>;
  },
): Promise<NextResponse> {
  const { id, versionId } = await context.params;

  try {
    const restored = await getRepositories().revisions.restore(id, versionId);

    return dataResponse({ content: restored.content, updatedAt: restored.updatedAt });
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      return errorResponse("not_found", "That version no longer exists.");
    }

    console.error("POST /api/scripts/{id}/revisions/{versionId}/restore failed", error);

    return errorResponse("invalid_request", "The version could not be restored.");
  }
}
