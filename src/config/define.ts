/**
 * `defineConfig` — the top-level loader.
 *
 * Pipeline:
 *
 * 1. Resolve the deployment environment from
 *    `options.environment` → `APP_ENV` → `NODE_ENV` (default `"development"`).
 * 2. Build the source stack — `.env` (disabled in production), env, CLI —
 *    queried highest-priority-first per leaf. Callers may override the
 *    stack entirely via `options.sources`.
 * 3. Walk the schema once, collecting one entry per leaf.
 * 4. For each leaf, query the source stack; fall back to the leaf's
 *    declared default; report `missing` only when no source hits and
 *    the leaf is neither optional nor defaulted.
 * 5. Parse the raw value through the leaf; collect every error before
 *    failing fast — boot diagnostics aggregate, never short-circuit.
 * 6. On failure: render the diagnostic table to stderr and `exit(1)`
 *    (or throw a {@link ConfigValidationError} when
 *    `throwOnError: true`).
 * 7. On success: assemble the typed tree, deep-freeze it, return.
 *
 * @module
 */

import {
  type ConfigDiagnostic,
  ConfigValidationError,
} from "./errors";
import { writeFailFast } from "./diagnostics";
import { collectLeaves, deepFreeze, setAtPath } from "./schema/walk";
import { cliSource } from "./sources/cli";
import { dotenvSource } from "./sources/dotenv";
import { envSource } from "./sources/env";
import type { ConfigSource, SourceLookup } from "./sources/types";
import type { ConfigSchema, Infer } from "./types";

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
  const environment = resolveEnvironment(options);
  const sources = options.sources ?? defaultSources(environment);

  const leaves = collectLeaves(schema);
  const issues: ConfigDiagnostic[] = [];
  const tree: Record<string, unknown> = {};

  for (const entry of leaves) {
    const lookup: SourceLookup = { path: entry.path, envVar: entry.envVar };
    const raw = readFromSources(sources, lookup);

    if (raw === undefined) {
      if (entry.leaf.hasDefault) {
        setAtPath(tree, entry.path, entry.leaf.defaultValue);
        continue;
      }
      if (entry.leaf.isOptional) {
        // Optional leaves are present-but-undefined in the result
        // tree so consumers can use `?.` consistently.
        setAtPath(tree, entry.path, undefined);
        continue;
      }
      issues.push({
        path: entry.path,
        envVar: entry.envVar,
        status: "missing",
        reason: missingReason(entry.leaf),
      });
      continue;
    }

    const parsed = entry.leaf.parse(raw);
    if (parsed.ok) {
      setAtPath(tree, entry.path, parsed.value);
    } else {
      issues.push({
        path: entry.path,
        envVar: entry.envVar,
        status: "invalid",
        reason: parsed.reason,
        // Never echo secret values into diagnostics.
        ...(entry.leaf.isSecret ? {} : { received: raw }),
      });
    }
  }

  if (issues.length > 0) {
    if (options.throwOnError === true) {
      throw new ConfigValidationError(
        `Forge configuration invalid — ${issues.length} issue(s).`,
        { issues },
      );
    }
    writeFailFast(issues, options.diagnostics ?? {});
  }

  return deepFreeze(tree) as Infer<S>;
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

function missingReason(leaf: import("./schema/types").Leaf<unknown>): string {
  // Enum leaves get a tailored "Must be one of …" message — matches
  // the spec example.
  const variants = (leaf as { variants?: readonly string[] }).variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return `Must be one of: ${variants.join(", ")}.`;
  }
  return `Required ${leaf.kind} value is missing.`;
}
