/**
 * `/api/scripts/{id}/revisions` — the undo affordance's list (contracts/http-api.md).
 *
 *   GET → the script's recoverable versions, newest first
 *
 * Only a preview (the first 200 characters) is returned, never the full
 * document: the list shows where an undo would land, and the document itself is
 * already on screen in the editor. An unknown script is a not-found response;
 * a script that has never changed is an empty history.
 */

import { NextResponse } from "next/server";

import { dataResponse, errorResponse } from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError } from "@/lib/repositories/types";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    return dataResponse(await getRepositories().revisions.list(id));
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      return errorResponse("not_found", "That script no longer exists.");
    }

    console.error("GET /api/scripts/{id}/revisions failed", error);

    return errorResponse("invalid_request", "The script's history could not be loaded.");
  }
}
