/**
 * The model provider (constitution, Technology Stack).
 *
 * OpenRouter is reached through `@openrouter/ai-sdk-provider`, and the model is
 * chosen at runtime by `OPENROUTER_MODEL`. No model name is hardcoded at a call
 * site: swapping models is an environment change, never a code change, which is
 * what makes constitution v1.3.0's configurable-provider rule real.
 *
 * The endpoint itself is configuration too (`OPENROUTER_BASE_URL`), defaulting
 * to OpenRouter. It exists so an end-to-end test can point the provider at a
 * stub it controls; production leaves it unset.
 *
 * Server-only. The API key must never reach the browser, so nothing in the
 * client component tree may import this module.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { Env, EnvSource } from "@/env";

/**
 * The chat model type this provider returns.
 *
 * Derived from the factory rather than spelled as the SDK's `LanguageModel`
 * union: the union includes every model slug the vendor SDK knows, which makes
 * `modelId` unreadable, while the concrete chat model exposes the id and the
 * provider name the configuration test needs to assert on.
 */
export type ScriptModel = ReturnType<ReturnType<typeof createOpenRouter>["chat"]>;

/** Where OpenRouter's API is, unless `OPENROUTER_BASE_URL` names another. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The provider settings the model is built with. */
export interface ScriptProviderConfig {
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseURL?: string;
}

/**
 * The provider configuration, read from the environment.
 *
 * @throws {Error} When either required value is empty, for the reason
 *   {@link createScriptModel} gives.
 */
export function providerConfigFrom(
  env: Env,
  source: EnvSource = process.env,
): ScriptProviderConfig {
  const apiKey = env.openRouterApiKey?.trim() ?? "";
  const modelId = env.openRouterModel?.trim() ?? "";

  if (apiKey === "") {
    throw new Error("Missing required environment variable: OPENROUTER_API_KEY");
  }

  if (modelId === "") {
    throw new Error("Missing required environment variable: OPENROUTER_MODEL");
  }

  const baseURL = source.OPENROUTER_BASE_URL?.trim();

  return baseURL ? { apiKey, modelId, baseURL } : { apiKey, modelId };
}

/**
 * The configured endpoint: the variable when it names one, OpenRouter
 * otherwise.
 */
export function openRouterBaseUrl(source: EnvSource = process.env): string {
  return source.OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE_URL;
}

/**
 * The model a chat request should use, built from validated configuration.
 *
 * @throws {Error} When either configuration value is empty. Defaulting to some
 *   other model here would silently bill and behave differently from what was
 *   configured, so the call fails loudly instead.
 */
export function createScriptModel(env: Env): ScriptModel {
  const { apiKey, modelId, baseURL } = providerConfigFrom(env);

  return createOpenRouter({ apiKey, baseURL: baseURL ?? OPENROUTER_BASE_URL }).chat(
    modelId,
  );
}
