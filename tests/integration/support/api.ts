/**
 * Calling Next.js route handlers from an integration test.
 *
 * The handlers are plain functions of a `Request`, so they are exercised
 * directly rather than through a running server: the test proves the handler's
 * contract (status, envelope, headers), not Next.js's router. Fields typed as
 * `unknown` are read through small helpers so a wrong shape fails as a readable
 * assertion instead of a property access on `undefined`.
 */

import type { NextRequest } from "next/server";

type RouteHandler = (request: NextRequest) => Promise<Response> | Response;

/** Builds a `Request` with an optional JSON body. */
export function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new Request(url, {
    method,
    headers:
      body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as NextRequest;
}

export interface HandledResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

/**
 * Invokes a route handler with a request, capturing the response's body while
 * it is still a plain (non-streaming) response and releasing it afterwards.
 */
export async function callRoute(
  handler: RouteHandler,
  request: NextRequest,
): Promise<HandledResponse> {
  const response = await handler(request);
  const text = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    text,
    json: parseJson(text),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads a property from an unknown JSON value, for assertions. */
export function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The error code of an error envelope (contracts/http-api.md), if present. */
export function errorCode(json: unknown): unknown {
  return field(field(json, "error"), "code");
}

/** The error message of an error envelope, if present. */
export function errorMessage(json: unknown): unknown {
  return field(field(json, "error"), "message");
}
