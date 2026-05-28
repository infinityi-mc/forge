/**
 * CLI-argument source.
 *
 * Accepts the two shapes the module spec calls out:
 *
 * - `--app.port=8080`  (single-token, `=`-separated)
 * - `--app.port 8080`  (space-separated, value is the next argv token)
 *
 * Either the dotted path (`--app.port`) or the env-var name
 * (`--APP_PORT`) matches a leaf. Anything else (positional arguments,
 * short flags, repeated flags, subcommands) is intentionally
 * unsupported per the spec's "we are not yargs/commander" constraint.
 *
 * @module
 */

import type { ConfigSource, SourceLookup } from "./types";

export interface CliSourceOptions {
  /** Override argv. Defaults to `process.argv.slice(2)`. */
  argv?: readonly string[];
}

/**
 * Build a CLI source by parsing argv into a flat string map keyed by
 * the flag name as-written. Both `--app.port` and `--APP_PORT` are
 * preserved verbatim so lookup can match on either convention.
 */
export function cliSource(options: CliSourceOptions = {}): ConfigSource {
  const argv = options.argv ?? process.argv.slice(2);
  const flags = parseFlags(argv);

  return {
    name: "cli",
    get(lookup: SourceLookup): string | undefined {
      // Prefer the dotted-path form, fall back to the env-var form.
      // Either lets a developer write the flag in whichever style
      // matches their muscle memory.
      return flags[lookup.path] ?? flags[lookup.envVar];
    },
  };
}

/**
 * Parse argv tokens into a flat `{ name: value }` map. Boolean-style
 * flags (`--debug` without a value) are recorded as the string
 * `"true"` so the boolean leaf parser accepts them naturally.
 */
export function parseFlags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    if (body.length === 0) continue;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    // No `=` — next token is the value unless it's the start of
    // another flag, in which case treat the current flag as boolean.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[body] = "true";
      continue;
    }
    out[body] = next;
    i++;
  }
  return out;
}
