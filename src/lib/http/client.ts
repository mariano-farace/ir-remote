/**
 * The browser's one way to call the route handlers (contracts/http-api.md).
 *
 * Every route answers in the same envelope — `{ data }` on success,
 * `{ error: { code, message } }` on failure — so the client decodes it once
 * here. Errors are returned as values, never thrown: a caller that forgets to
 * catch would otherwise turn a refused title into a blank panel.
 */

/** The error envelope's shape, as far as the client reads it. */
export interface ApiError {
  readonly code: string;
  /** Already user-facing copy (the contract guarantees it); render it as-is. */
  readonly message: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

/** For failures with no server message, so the UI never has to invent copy. */
const UNREACHABLE: ApiError = {
  code: "unreachable",
  message:
    "The workspace could not reach the server. Check your connection and try again.",
};

function hasError(value: unknown): value is { error: ApiError } {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }

  const error = (value as { error: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as ApiError).code === "string" &&
    typeof (error as ApiError).message === "string"
  );
}

function hasData(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
}

/**
 * Sends one request and decodes the envelope.
 *
 * @param path An API path, for example `/api/scripts`.
 * @param init Standard `fetch` options; a `body` object is serialised as JSON.
 */
export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }

  // A successful 204 has no envelope to decode: no content is the success.
  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const json: unknown = await response.json().catch(() => undefined);

  if (hasError(json)) {
    return { ok: false, error: json.error };
  }

  if (!response.ok || !hasData(json)) {
    return { ok: false, error: UNREACHABLE };
  }

  return { ok: true, data: json.data as T };
}

/**
 * `fetch` as the chat transport needs it: the request as given, checked for
 * transport failure and any non-streamed error envelope, then handed back as a
 * `Response` for the AI SDK to read. A streamed chat answer passes through
 * untouched — its events are the SDK's, not the envelope's.
 */
export async function envelopeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    return Response.json(
      { error: UNREACHABLE },
      { status: 503, statusText: "Service Unavailable" },
    );
  }

  if (
    !response.ok &&
    response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }

  return response;
}
