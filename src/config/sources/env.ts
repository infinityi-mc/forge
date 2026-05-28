/**
 * Environment-variable source — reads from `Bun.env` (falling back to
 * `process.env` on platforms where `Bun.env` is unavailable).
 *
 * @module
 */

import type { ConfigSource, SourceLookup } from "./types";

export interface EnvSourceOptions {
  /**
   * Pre-resolved env map. When supplied, the source ignores
   * `Bun.env` / `process.env` entirely — useful for deterministic
   * tests and for callers who have already built their own merged
   * env (e.g. from a secret manager).
   */
  env?: Record<string, string | undefined>;
}

/**
 * Build an env-var source. The lookup uses `lookup.envVar` only; the
 * dotted path is ignored.
 */
export function envSource(options: EnvSourceOptions = {}): ConfigSource {
  const env =
    options.env ??
    (typeof Bun !== "undefined" && Bun.env
      ? (Bun.env as Record<string, string | undefined>)
      : (process.env as Record<string, string | undefined>));

  return {
    name: "env",
    get(lookup: SourceLookup): string | undefined {
      return env[lookup.envVar];
    },
  };
}
