/**
 * `.env` file source.
 *
 * Per the module spec, `.env` files are strictly a development /
 * test affordance. When `defineConfig` resolves the environment to
 * `"production"`, the source self-disables — its `get()` always
 * returns `undefined`, regardless of file contents — so no production
 * deployment can accidentally read a checked-in `.env`.
 *
 * The file is read synchronously at source construction. `defineConfig`
 * is synchronous (the spec example `export const config = defineConfig(schema)`
 * relies on this), which precludes Bun's async `Bun.file(...).text()`
 * helper. `node:fs.readFileSync` works under both Bun and Node and is
 * the canonical synchronous read API.
 *
 * @module
 */

import { readFileSync } from "node:fs";

import { ConfigSourceError } from "../errors";
import type { ConfigSource, SourceLookup } from "./types";

export interface DotenvSourceOptions {
  /** File path. Defaults to `.env` in the current working directory. */
  path?: string;
  /**
   * When `true`, the source returns `undefined` for every lookup,
   * regardless of whether the file exists. Set automatically by
   * `defineConfig` when the resolved environment is `"production"`.
   */
  disabled?: boolean;
  /**
   * When `true`, an unreadable / malformed file throws a
   * {@link ConfigSourceError} at load time. When `false` (the
   * default), the file is silently treated as empty — matching the
   * dev-ergonomic expectation of `.env` being optional.
   */
  strict?: boolean;
  /**
   * Override the raw text content of the `.env` file. When supplied,
   * the source skips disk I/O entirely. Useful for tests and for
   * callers that have already resolved their `.env` from a custom
   * location.
   */
  content?: string;
}

/**
 * Build a `.env` file source. The file is read once, eagerly. Callers
 * that need hot-reload semantics should use `defineDynamicConfig`
 * (ships in PR B), not this source.
 */
export function dotenvSource(options: DotenvSourceOptions = {}): ConfigSource {
  const path = options.path ?? ".env";
  const disabled = options.disabled === true;
  const strict = options.strict === true;

  const map = disabled
    ? {}
    : parseDotenv(
        options.content !== undefined
          ? options.content
          : readDotenvFile(path, strict),
      );

  return {
    name: "dotenv",
    get(lookup: SourceLookup): string | undefined {
      return map[lookup.envVar];
    },
  };
}

function readDotenvFile(path: string, strict: boolean): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (strict) {
      throw new ConfigSourceError(`Unable to read .env file at ${path}.`, {
        source: "dotenv",
        cause,
      });
    }
    return "";
  }
}

/**
 * Tiny dotenv parser. Handles the canonical 12-Factor shape:
 *
 * - `KEY=value` (trims whitespace around `=`).
 * - `KEY="value"` / `KEY='value'` (preserves inner whitespace;
 *   processes `\n` / `\r` / `\t` escapes inside double quotes only).
 * - `# comment` lines and trailing `# comments` (outside quotes).
 * - `export KEY=value` (shell-compatible).
 * - Empty lines.
 *
 * Anything more elaborate (multi-line values, variable expansion) is
 * deliberately out of scope per the module spec.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length === 0) {
      out[key] = "";
      continue;
    }
    const first = value[0];
    if (first === '"' || first === "'") {
      const closeIdx = value.lastIndexOf(first);
      if (closeIdx > 0) {
        value = value.slice(1, closeIdx);
        if (first === '"') {
          value = value
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"');
        }
        out[key] = value;
        continue;
      }
    }
    // Unquoted — strip trailing `# comment` (preceded by whitespace).
    const hashIdx = value.search(/\s#/);
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    out[key] = value;
  }
  return out;
}
