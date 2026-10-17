/**
 * The model provider (constitution, Technology Stack).
 *
 * OpenRouter is reached through `@openrouter/ai-sdk-provider`, and the model is
 * chosen at runtime by `OPENROUTER_MODEL`. No model name is hardcoded at a call
 * site: swapping models is an environment change, never a code change, which is
 * what makes constitution v1.3.0's configurable-provider rule real.
 *
 * Server-only. The API key must never reach the browser, so nothing in the
 * client component tree may import this module.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { Env } from "@/env";

/**
 * The chat model type this provider returns.
 *
 * Derived from the factory rather than spelled as the SDK's `LanguageModel`
 * union: the union includes every model slug the vendor SDK knows, which makes
 * `modelId` unreadable, while the concrete chat model exposes the id and the
 * provider name the configuration test needs to assert on.
 */
export type ScriptModel = ReturnType<ReturnType<typeof createOpenRouter>["chat"]>;

/**
 * The model a chat request should use, built from validated configuration.
 *
 * @throws {Error} When either configuration value is empty. Defaulting to some
 *   other model here would silently bill and behave differently from what was
 *   configured, so the call fails loudly instead.
 */
export function createScriptModel(env: Env): ScriptModel {
  const apiKey = env.openRouterApiKey?.trim() ?? "";
  const modelId = env.openRouterModel?.trim() ?? "";

  if (apiKey === "") {
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }

  if (modelId === "") {
    throw new Error("Missing required environment variable: OPENROUTER_MODEL");
  }

  return createOpenRouter({ apiKey }).chat(modelId);
}
