import { describe, expect, it } from "vitest";

import { loadEnv } from "@/env";

const COMPLETE = {
  OPENROUTER_API_KEY: "sk-or-test",
  OPENROUTER_MODEL: "anthropic/claude-sonnet-4.5",
};

describe("loadEnv", () => {
  it("returns the validated configuration when both variables are present", () => {
    const env = loadEnv(COMPLETE);

    expect(env).toEqual({
      openRouterApiKey: "sk-or-test",
      openRouterModel: "anthropic/claude-sonnet-4.5",
    });
  });

  it("throws naming OPENROUTER_API_KEY when it is missing", () => {
    expect(() => loadEnv({ OPENROUTER_MODEL: COMPLETE.OPENROUTER_MODEL })).toThrowError(
      /OPENROUTER_API_KEY/,
    );
  });

  it("throws naming OPENROUTER_MODEL when it is missing", () => {
    expect(() =>
      loadEnv({ OPENROUTER_API_KEY: COMPLETE.OPENROUTER_API_KEY }),
    ).toThrowError(/OPENROUTER_MODEL/);
  });
});
