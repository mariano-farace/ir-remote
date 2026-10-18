/**
 * The HTTP envelope every route handler speaks (contracts/http-api.md).
 *
 * One success shape, one error shape, and one table mapping a failure code to
 * its status and user-facing message. Keeping the table here — rather than a
 * literal in each handler — is what makes an error *actionable*: the client can
 * render the message without inventing copy, and a code can only mean one thing.
 */

import { NextResponse } from "next/server";

export type ErrorCode =
  | "invalid_request"
  | "title_required"
  | "title_taken"
  | "invalid_style"
  | "not_found"
  | "stale_write"
  | "conversation_mismatch"
  | "clear_requires_confirmation"
  /** A destructive request arrived without the user's confirmation (FR-001d). */
  | "confirmation_required";

interface ErrorDefinition {
  readonly status: number;
  readonly message: string;
}

export const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  invalid_request: {
    status: 400,
    message: "The request was not understood. Check the input and try again.",
  },
  title_required: {
    status: 400,
    message: "A script title is required, and it must be at most 200 characters long.",
  },
  title_taken: {
    status: 409,
    message: "Another script already uses this title. Choose a different one.",
  },
  invalid_style: {
    status: 400,
    message: "That style is not in the catalogue.",
  },
  not_found: {
    status: 404,
    message: "That item no longer exists.",
  },
  stale_write: {
    status: 409,
    message:
      "The script changed elsewhere after it was loaded, so this save was not applied. Reload the script to see the newer text.",
  },
  conversation_mismatch: {
    status: 400,
    message: "The conversation does not belong to that script.",
  },
  clear_requires_confirmation: {
    status: 409,
    message: "This change needs your confirmation before it can be applied.",
  },
  confirmation_required: {
    status: 400,
    message:
      "This action removes the script and everything in it. Confirm it to continue.",
  },
};

/**
 * The message for an error code. `detail` may add context (for example, which
 * field was invalid) but is always phrased for the user: it never carries a
 * stack trace, SQL, a key, or prompt contents.
 */
export function messageFor(code: ErrorCode, detail?: string): string {
  const base = ERROR_DEFINITIONS[code].message;

  return detail ? `${base} ${detail}` : base;
}

export function errorResponse(code: ErrorCode, detail?: string): NextResponse {
  return NextResponse.json(
    { error: { code, message: messageFor(code, detail) } },
    { status: ERROR_DEFINITIONS[code].status },
  );
}

export function dataResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

/** A required string property, including an empty string, or `undefined`. */
export function requiredString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "string" ? value : undefined;
}

/** Parses a JSON request body, or returns `undefined` for anything malformed. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** A required, non-empty string property, or `undefined`. */
export function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** An optional string property; `null` and absence both mean "not supplied". */
export function optionalStringField(
  body: unknown,
  key: string,
): string | null | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return value === null ? null : typeof value === "string" ? value : undefined;
}
