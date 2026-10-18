import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, envelopeFetch } from "@/lib/http/client";

/**
 * The envelope decoder (contracts/http-api.md).
 *
 * Every route answers `{ data }` or `{ error: { code, message } }`, and the
 * client decodes that once for all of them. A 204 is the one success without a
 * body — the deletion contract's response — and must not be mistaken for an
 * unreachable server or a malformed answer.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

describe("apiRequest", () => {
  it("returns the data of a success envelope", async () => {
    respond(Response.json({ data: { id: "script-a" } }));

    await expect(apiRequest("/api/scripts/script-a")).resolves.toEqual({
      ok: true,
      data: { id: "script-a" },
    });
  });

  it("reports a 204 as success with no data rather than as unreachable", async () => {
    respond(new Response(null, { status: 204 }));

    await expect(
      apiRequest("/api/scripts/script-a", { method: "DELETE" }),
    ).resolves.toEqual({
      ok: true,
      data: undefined,
    });
  });

  it("returns the server's error envelope as a value", async () => {
    respond(
      Response.json(
        { error: { code: "not_found", message: "That script no longer exists." } },
        { status: 404 },
      ),
    );

    await expect(apiRequest("/api/scripts/missing")).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "That script no longer exists." },
    });
  });

  it("reports a success status with no envelope as unreachable", async () => {
    respond(new Response("not json", { status: 200 }));

    const result = await apiRequest("/api/scripts");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("unreachable");
  });

  it("sends a JSON body and method when given one", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: null }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/scripts/a", { method: "DELETE", body: { confirm: true } });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scripts/a",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("reports a transport failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const result = await apiRequest("/api/scripts");

    expect(!result.ok && result.error.code).toBe("unreachable");
  });

  it("reports an error status with no envelope as unreachable", async () => {
    respond(new Response("Bad Gateway", { status: 502 }));

    const result = await apiRequest("/api/scripts");

    expect(!result.ok && result.error.code).toBe("unreachable");
  });

  it("passes an abort signal through, so a caller can give up on a request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/scripts", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scripts",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("envelopeFetch", () => {
  it("hands a streamed answer back untouched for the chat SDK to read", async () => {
    const streamed = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed),
    );

    await expect(envelopeFetch("/api/chat", { method: "POST" })).resolves.toBe(streamed);
  });

  it("hands a non-streamed error envelope back rather than streaming it", async () => {
    const refusal = Response.json(
      { error: { code: "style_required", message: "Choose a style first." } },
      { status: 400 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refusal),
    );

    const response = await envelopeFetch("/api/chat", { method: "POST" });

    expect(response).toBe(refusal);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "style_required" },
    });
  });

  it("turns a transport failure into an error envelope the chat SDK can read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const response = await envelopeFetch("/api/chat", { method: "POST" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unreachable" },
    });
  });

  it("lets a stop through as an abort rather than reporting the server unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      }),
    );

    await expect(envelopeFetch("/api/chat", { method: "POST" })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
