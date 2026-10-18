import { describe, expect, it } from "vitest";

import {
  createScriptModel,
  OPENROUTER_BASE_URL,
  openRouterBaseUrl,
  providerConfigFrom,
} from "@/lib/ai/provider";

const CONFIGURED = {
  openRouterApiKey: "sk-or-v1-test-key",
  openRouterModel: "anthropic/claude-sonnet-4.5",
};

describe("createScriptModel", () => {
  it("addresses the model named by configuration", () => {
    const model = createScriptModel(CONFIGURED);

    expect(model.modelId).toBe("anthropic/claude-sonnet-4.5");
  });

  it("follows configuration rather than a pinned name", () => {
    const model = createScriptModel({ ...CONFIGURED, openRouterModel: "openai/gpt-5.1" });

    expect(model.modelId).toBe("openai/gpt-5.1");
  });

  it("routes through the OpenRouter provider", () => {
    const model = createScriptModel(CONFIGURED);

    expect(model.provider).toBe("openrouter");
  });

  describe("fails loudly rather than defaulting", () => {
    it("rejects an empty model slug", () => {
      expect(() =>
        createScriptModel({ ...CONFIGURED, openRouterModel: "" }),
      ).toThrowError(/OPENROUTER_MODEL/);
    });

    it("rejects a whitespace-only model slug", () => {
      expect(() =>
        createScriptModel({ ...CONFIGURED, openRouterModel: "   " }),
      ).toThrowError(/OPENROUTER_MODEL/);
    });

    it("rejects a missing model slug instead of choosing one", () => {
      const { openRouterApiKey } = CONFIGURED;
      const config = { openRouterApiKey } as typeof CONFIGURED;

      expect(() => createScriptModel(config)).toThrowError(/OPENROUTER_MODEL/);
    });

    it("rejects a missing API key", () => {
      expect(() =>
        createScriptModel({ ...CONFIGURED, openRouterApiKey: "" }),
      ).toThrowError(/OPENROUTER_API_KEY/);
    });

    it("names the missing variable, so a misconfigured deployment is diagnosable", () => {
      const error = (() => {
        try {
          createScriptModel({ ...CONFIGURED, openRouterModel: " " });
        } catch (caught) {
          return caught as Error;
        }

        return undefined;
      })();

      expect(error?.message).toContain("OPENROUTER_MODEL");
      // The message must never echo the secret it was given.
      expect(error?.message).not.toContain(CONFIGURED.openRouterApiKey);
    });
  });
});

describe("the endpoint the provider calls", () => {
  it("is OpenRouter's API when nothing is configured", () => {
    expect(openRouterBaseUrl({})).toBe("https://openrouter.ai/api/v1");
    expect(providerConfigFrom(CONFIGURED, {})).toEqual({
      apiKey: CONFIGURED.openRouterApiKey,
      modelId: CONFIGURED.openRouterModel,
    });
  });

  it("is OPENROUTER_BASE_URL when it names one, so a test can stub the upstream", () => {
    const source = { OPENROUTER_BASE_URL: "http://127.0.0.1:4010" };

    expect(openRouterBaseUrl(source)).toBe("http://127.0.0.1:4010");
    expect(providerConfigFrom(CONFIGURED, source)).toMatchObject({
      baseURL: "http://127.0.0.1:4010",
    });
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("treats a blank or whitespace-only address as unset rather than an empty URL", () => {
    for (const value of ["", "   "]) {
      expect(openRouterBaseUrl({ OPENROUTER_BASE_URL: value })).toBe(OPENROUTER_BASE_URL);
      expect(
        providerConfigFrom(CONFIGURED, { OPENROUTER_BASE_URL: value }),
      ).not.toHaveProperty("baseURL");
    }
  });

  it("still refuses to build a model without its required settings", () => {
    expect(() =>
      providerConfigFrom(
        { ...CONFIGURED, openRouterApiKey: "" },
        {
          OPENROUTER_BASE_URL: "http://127.0.0.1:4010",
        },
      ),
    ).toThrowError(/OPENROUTER_API_KEY/);
  });
});
