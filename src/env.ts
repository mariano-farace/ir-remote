/**
 * Startup validation of required configuration.
 *
 * Secrets are read server-side only; nothing here may be imported into a
 * client component. The constitution requires a missing secret to fail fast
 * at boot rather than at the first request, and the error must name the
 * variable that is missing.
 */

export interface Env {
  openRouterApiKey: string;
  openRouterModel: string;
}

export type EnvSource = Record<string, string | undefined>;

const REQUIRED_VARS = {
  openRouterApiKey: "OPENROUTER_API_KEY",
  openRouterModel: "OPENROUTER_MODEL",
} as const satisfies Record<keyof Env, string>;

function readRequired(source: EnvSource, name: string): string {
  const raw = source[name];
  const value = raw?.trim() ?? "";

  if (value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function loadEnv(source: EnvSource = process.env): Env {
  return {
    openRouterApiKey: readRequired(source, REQUIRED_VARS.openRouterApiKey),
    openRouterModel: readRequired(source, REQUIRED_VARS.openRouterModel),
  };
}
