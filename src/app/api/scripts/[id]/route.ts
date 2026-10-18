/**
 * `/api/scripts/{id}` — opening and removing one script (contracts/http-api.md).
 *
 *   GET    → the script with its document and its conversation's id (FR-003)
 *   PATCH  → rename, under the same rules as creation (FR-001c)
 *   DELETE → the script and everything it owns (FR-001d)
 *
 * The conversation id is part of the GET response because the chat panel must
 * address *this* script's conversation and no other (FR-006); reading the
 * script and its conversation together here keeps the client from having to
 * match them up afterwards.
 *
 * DELETE is destructive and irreversible (spec Out of Scope: no trash), so it
 * requires an explicit `{ "confirm": true }` in the body. The confirmation is
 * checked here, before the repository is touched: a request that omits it
 * removes nothing.
 */

import { NextResponse } from "next/server";

import { checkTitle } from "@/lib/domain/title";
import {
  dataResponse,
  errorResponse,
  readJsonBody,
  stringField,
} from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError } from "@/lib/repositories/types";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const repositories = getRepositories();

  try {
    const script = await repositories.scripts.get(id);
    const conversation = await repositories.conversations.getByScriptId(script.id);

    return dataResponse({
      id: script.id,
      title: script.title,
      content: script.content,
      styleId: script.styleId,
      createdAt: script.createdAt,
      updatedAt: script.updatedAt,
      conversationId: conversation.id,
    });
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      // Covers an unknown id and a malformed one alike: a non-UUID cannot be a
      // script, and the driver's complaint must not reach the browser.
      return errorResponse("not_found", "That script no longer exists.");
    }

    console.error("GET /api/scripts/{id} failed", error);

    return errorResponse("invalid_request", "The script could not be loaded.");
  }
}

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  const rawTitle = stringField(body, "title");

  // The same distinction creation makes: a missing or blank title is
  // `title_required`, never a generic bad request (FR-001a, FR-001b).
  if (rawTitle === undefined) {
    return errorResponse("title_required", "The title cannot be blank.");
  }

  const check = checkTitle(rawTitle);

  if (!check.valid) {
    return errorResponse(
      "title_required",
      check.rule === "blank"
        ? "The title cannot be blank."
        : "The title must be at most 200 characters.",
    );
  }

  try {
    const renamed = await getRepositories().scripts.rename(id, check.title);

    return dataResponse({
      id: renamed.id,
      title: renamed.title,
      updatedAt: renamed.updatedAt,
    });
  } catch (error) {
    if (error instanceof RepositoryError) {
      if (error.code === "not_found") {
        return errorResponse("not_found", "That script no longer exists.");
      }

      if (error.code === "title_taken") {
        return errorResponse("title_taken");
      }

      if (error.code === "title_required") {
        return errorResponse("title_required");
      }
    }

    console.error("PATCH /api/scripts/{id} failed", error);

    return errorResponse("invalid_request", "The script could not be renamed.");
  }
}

export async function DELETE(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = await readJsonBody(request);

  // Strictly `true`: a missing body, a string "true", or a falsy value is a
  // request that did not carry the user's confirmation.
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { confirm?: unknown }).confirm !== true
  ) {
    return errorResponse("confirmation_required");
  }

  try {
    await getRepositories().scripts.delete(id);
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      return errorResponse("not_found", "That script no longer exists.");
    }

    console.error("DELETE /api/scripts/{id} failed", error);

    return errorResponse("invalid_request", "The script could not be deleted.");
  }

  return new NextResponse(null, { status: 204 });
}
