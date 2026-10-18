/**
 * `/api/scripts/{id}/messages` — restoring a reopened script's conversation
 * (contracts/http-api.md, FR-003, SC-003).
 *
 *   GET → the messages of the conversation this script owns, in creation order
 *
 * The conversation is looked up *from the script id*, never taken from the
 * client: a script's history is reachable only through the script, so one
 * script's turns cannot be loaded under another's id (FR-006).
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
  const repositories = getRepositories();

  try {
    const conversation = await repositories.conversations.getByScriptId(id);
    const messages = await repositories.conversations.getMessages(conversation.id);

    return dataResponse(
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    );
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") {
      return errorResponse("not_found", "That script no longer exists.");
    }

    console.error("GET /api/scripts/{id}/messages failed", error);

    return errorResponse("invalid_request", "The conversation could not be loaded.");
  }
}
