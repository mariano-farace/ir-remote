/**
 * `/api/scripts` — listing and creation (contracts/http-api.md).
 *
 *   GET  → every script for the sidebar, most recently modified first (FR-002)
 *   POST → create a script and its conversation atomically (FR-001)
 *
 * Validation happens here as well as in the repository: the route decides which
 * HTTP code a broken rule maps onto, and the repository's `RepositoryError`
 * codes are the vocabulary it reads, so neither layer has to know the other's
 * transport.
 */

import { NextResponse } from "next/server";

import { checkTitle } from "@/lib/domain/title";
import type { StyleId } from "@/lib/domain/types";
import {
  dataResponse,
  errorResponse,
  optionalStringField,
  readJsonBody,
  stringField,
} from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import { RepositoryError, type Repositories } from "@/lib/repositories/types";

export async function GET(): Promise<NextResponse> {
  try {
    return dataResponse(await getRepositories().scripts.list());
  } catch (error) {
    console.error("GET /api/scripts failed", error);

    return errorResponse("invalid_request", "The script list could not be loaded.");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonBody(request);

  if (body === undefined) {
    return errorResponse("invalid_request");
  }

  const rawTitle = stringField(body, "title");

  // A missing or blank title is `title_required`, not a generic bad request:
  // FR-001a forbids inventing a title, and the user must be told that.
  if (rawTitle === undefined) {
    return errorResponse(
      "title_required",
      "A script is never created without one you supply.",
    );
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

  const styleId = optionalStringField(body, "styleId");

  if (styleId === undefined) {
    return errorResponse("invalid_request", "`styleId` must be a string or null.");
  }

  const repositories = getRepositories();

  try {
    const created = await repositories.scripts.create({
      title: check.title,
      styleId: styleId ?? (await defaultStyleId(repositories)),
    });

    return dataResponse(
      {
        id: created.script.id,
        title: created.script.title,
        content: created.script.content,
        styleId: created.script.styleId,
        conversationId: created.conversation.id,
      },
      201,
    );
  } catch (error) {
    return errorResponseForCreate(error);
  }
}

/**
 * spec.md's Assumptions: a new script takes the first style in the catalogue
 * unless the user chooses otherwise.
 */
async function defaultStyleId(repositories: Repositories): Promise<StyleId | null> {
  const [first] = await repositories.styles.list();

  return first?.id ?? null;
}

function errorResponseForCreate(error: unknown): NextResponse {
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case "title_required":
        return errorResponse("title_required");
      case "title_taken":
        return errorResponse("title_taken");
      case "unknown_style":
        return errorResponse("invalid_style");
      default:
        break;
    }
  }

  console.error("POST /api/scripts failed", error);

  return errorResponse("invalid_request", "The script could not be created.");
}
