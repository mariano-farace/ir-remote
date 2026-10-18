/**
 * `/api/scripts/{id}/style` — assigning the script's single style
 * (contracts/http-api.md).
 *
 *   PUT → replace the style the script is written in (FR-009)
 *
 * The style is a reference into the read-only catalogue, so this route can only
 * point a script at an existing style: there is no way through it — or any
 * other endpoint — to create, edit, or delete one (FR-008). Replacing is the
 * only operation, because at most one style is ever associated with a script.
 *
 * The association takes effect on the *next* request: `/api/chat` loads the
 * style server-side on every turn, so no cached prompt has to be invalidated
 * and the existing document is untouched (FR-010, FR-011).
 */

import { NextResponse } from "next/server";

import {
  dataResponse,
  errorResponse,
  readJsonBody,
  stringField,
} from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError } from "@/lib/repositories/types";

export async function PUT(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  const styleId = stringField(body, "styleId");

  // A missing, blank, or non-string id is a style that cannot be in the
  // catalogue, and the contract reports both the same way (FR-009).
  if (styleId === undefined) {
    return errorResponse(
      "invalid_style",
      "`styleId` must name a style in the catalogue.",
    );
  }

  try {
    const applied = await getRepositories().scripts.assignStyle(id, styleId);

    return dataResponse({ styleId: applied.styleId });
  } catch (error) {
    if (error instanceof RepositoryError) {
      if (error.code === "unknown_style") {
        return errorResponse("invalid_style");
      }

      if (error.code === "not_found") {
        return errorResponse("not_found", "That script no longer exists.");
      }
    }

    console.error("PUT /api/scripts/{id}/style failed", error);

    return errorResponse("invalid_request", "The style could not be changed.");
  }
}
