/**
 * `defineConfig` — the top-level boot-time loader.
 *
 * Pipeline:
 *
 * 1. Resolve the deployment environment from
 *    `options.environment` → `APP_ENV` → `NODE_ENV` (default `"development"`).
 * 2. Build the source stack — `.env` (disabled in production), env, CLI —
 *    queried highest-priority-first per leaf. Callers may override the
 *    stack entirely via `options.sources`.
 * 3. Walk the schema once via {@link validateSnapshot}; aggregate every
 *    issue before failing — boot diagnostics never short-circuit on
 *    the first error.
 * 4. On failure: render the diagnostic table to stderr and `exit(1)`
 *    (or throw a {@link ConfigValidationError} when
 *    `throwOnError: true`).
 * 5. On success: deep-freeze the result, emit the optional boot
 *    summary, and return the typed tree.
 *
 * @module
 */

import { writeFailFast } from "./diagnostics";
import { ConfigValidationError } from "./errors";
import type { Logger } from "./logger";
import { emitBootSummary } from "./observability";
import { deepFreeze } from "./schema/walk";
import { cliSource } from "./sources/cli";
import { dotenvSource } from "./sources/dotenv";
import { envSource } from "./sources/env";
import type { ConfigSource, SourceLookup } from "./sources/types";
import type { ConfigSchema, Infer } from "./types";
import { validateSnapshot } from "./validate";

export interface DefineConfigOptions {
  /**
   * Override the default source stack. Lowest priority first
   * (matches the spec's loading order). When supplied, the built-in
   * dotenv/env/CLI stack is replaced entirely — callers who want to
   * extend it can compose with the exported source factories.
   */
  sources?: readonly ConfigSource[];
  /**
   * Throw a {@link ConfigValidationError} instead of rendering to
   * stderr and exiting. Library callers (and tests) opt into this so
   * the host application can decide how to surface the failure.
   * Defaults to `false`.
   */
  throwOnError?: boolean;
  /**
   * Override the resolved deployment environment. Otherwise:
   * `Bun.env.APP_ENV` then `Bun.env.NODE_ENV` then `"development"`.
   * Drives the production fence on the `.env` source.
   */
  environment?: string;
  /**
   * Override stderr / exit / color / width for the fail-fast writer.
   * Primarily useful in tests; production callers should not need
   * this.
   */
  diagnostics?: {
    stderr?: { write(chunk: string): unknown; isTTY?: boolean };
    exit?: (code: number) => never;
    color?: boolean;
    width?: number;
  };
  /**
   * Optional structured logger. When supplied, `defineConfig` emits a
   * single boot-summary line on success — `module`, `boot_time_ms`,
   * `sources`, `loaded_keys`, `redacted_keys`. Values are never
   * included. The logger is structurally typed so `forge/config`
   * stays free of a hard `forge/telemetry/log` dependency.
   */
  logger?: Logger;
}

/**
 * Load, validate, and freeze configuration from the surrounding
 * environment.
 *
 * @example Minimal usage
 * ```ts
 * import { defineConfig, t } from "forge/config";
 *
 * export const config = defineConfig({
 *   app: { port: t.port.default(3000), env: t.enum(["development", "production"]).required() },
 *   db: { url: t.url.required() },
 * });
 * ```
 */
export function defineConfig<S extends ConfigSchema>(
  schema: S,
  options: DefineConfigOptions = {},
): Infer<S> {
  const startedAt = performance.now();
  const environment = resolveEnvironment(options);
  const sources = options.sources ?? defaultSources(environment);

  const { tree, issues, loadedKeys, redactedKeys } = validateSnapshot(
    schema,
    (entry) => {
      const lookup: SourceLookup = { path: entry.path, envVar: entry.envVar };
      return readFromSources(sources, lookup);
    },
  );

  if (issues.length > 0) {
    if (options.throwOnError === true) {
      throw new ConfigValidationError(
        `Forge configuration invalid — ${issues.length} issue(s).`,
        { issues },
      );
    }
    writeFailFast(issues, options.diagnostics ?? {});
  }

  const frozen = deepFreeze(tree);

  if (options.logger !== undefined) {
    emitBootSummary(options.logger, {
      bootTimeMs: Math.round(performance.now() - startedAt),
      sources: sources.map((s) => s.name),
      loadedKeys,
      redactedKeys,
    });
  }

  return frozen;
}

/**
 * Build the default source stack ordered lowest-priority first.
 * Exposed so callers who want to extend (not replace) the stack can
 * spread it into their own array.
 */
export function defaultSources(environment: string): ConfigSource[] {
  const isProd = environment === "production";
  return [
    // `.env` is the lowest-priority real source — defaults still
    // win for un-set keys but env / CLI override it.
    dotenvSource({ disabled: isProd }),
    envSource(),
    cliSource(),
  ];
}

function resolveEnvironment(options: DefineConfigOptions): string {
  if (typeof options.environment === "string" && options.environment.length > 0) {
    return options.environment;
  }
  const env =
    typeof Bun !== "undefined" && Bun.env
      ? (Bun.env as Record<string, string | undefined>)
      : (process.env as Record<string, string | undefined>);
  const appEnv = env["APP_ENV"];
  if (typeof appEnv === "string" && appEnv.length > 0) return appEnv;
  const nodeEnv = env["NODE_ENV"];
  if (typeof nodeEnv === "string" && nodeEnv.length > 0) return nodeEnv;
  return "development";
}

/**
 * Query sources from highest to lowest priority. The first defined
 * value wins; an empty string is considered defined (intentionally
 * empty) and short-circuits.
 */
function readFromSources(
  sources: readonly ConfigSource[],
  lookup: SourceLookup,
): string | undefined {
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]!;
    const value = source.get(lookup);
    if (value !== undefined) return value;
  }
  return undefined;
}
