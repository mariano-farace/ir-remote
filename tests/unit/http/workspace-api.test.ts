import { afterEach, describe, expect, it, vi } from "vitest";

import { assignScriptStyle, deleteScript } from "@/lib/http/workspace-api";

/**
 * The writes that carry the workspace's two destructive decisions
 * (contracts/http-api.md): deleting a script is sent already confirmed, and
 * assigning a style replaces the script's single style rather than adding one
 * (FR-001d, FR-009). Only the request is exercised here — the route handlers
 * that honour these bodies are covered against a real database.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    Response.json({ data: { styleId: "mystery" }, status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("workspace API writes", () => {
  it("sends the deletion already confirmed, so nothing is removed without one", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteScript("script-a");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scripts/script-a",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it("assigns exactly one style to the script", async () => {
    const fetchMock = capture();

    const result = await assignScriptStyle("script-a", "mystery");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scripts/script-a/style",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ styleId: "mystery" }),
      }),
    );
    expect(result).toEqual({ ok: true, data: { styleId: "mystery" } });
  });
});
