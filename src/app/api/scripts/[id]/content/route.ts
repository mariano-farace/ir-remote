/**
 * `/api/scripts/{id}/content` — the autosave target (contracts/http-api.md).
 *
 *   PUT → replace the document text, conditional on `baseUpdatedAt`
 *
 * `baseUpdatedAt` is the `updatedAt` the client last observed. When the stored
 * value has moved past it, another writer saved in between and this write is
 * refused with `409 stale_write` instead of overwriting the newer text
 * (FR-019). The repository writes the prior content as a revision in the same
 * transaction as the new content (FR-020), so a save is always undoable.
 *
 * The editor is the user's write path (origin `user`); an AI revision reaches
 * the same endpoint through the same state transition.
 */

import { NextResponse } from "next/server";

import {
  dataResponse,
  errorResponse,
  readJsonBody,
  requiredString,
} from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError } from "@/lib/repositories/types";

export async function PUT(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  const content = requiredString(body, "content");
  const baseUpdatedAt = requiredString(body, "baseUpdatedAt");

  if (content === undefined || baseUpdatedAt === undefined) {
    return errorResponse(
      "invalid_request",
      "`content` and `baseUpdatedAt` are both required, and both must be strings.",
    );
  }

  try {
    const written = await getRepositories().scripts.updateContent(
      id,
      content,
      baseUpdatedAt,
      "user",
    );

    return dataResponse(written);
  } catch (error) {
    if (error instanceof RepositoryError) {
      if (error.code === "not_found") {
        return errorResponse("not_found", "That script no longer exists.");
      }

      if (error.code === "stale_write") {
        return errorResponse("stale_write");
      }
    }

    console.error("PUT /api/scripts/{id}/content failed", error);

    return errorResponse("invalid_request", "The script could not be saved.");
  }
}
