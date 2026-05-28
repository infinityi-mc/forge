/**
 * `writeFailFast` — render the diagnostic table to stderr and exit.
 *
 * Split from the formatter so `defineConfig({ throwOnError: true })`
 * (and tests) can render the same table without exiting the process.
 *
 * @module
 */

import type { ConfigDiagnostic } from "../errors";
import { formatDiagnostics } from "./format";

export interface WriteFailFastOptions {
  /** Override the stderr sink (typically for tests). */
  stderr?: { write(chunk: string): unknown; isTTY?: boolean };
  /** Override the exit hook (typically for tests). Default: `process.exit`. */
  exit?: (code: number) => never;
  /** Force-enable / disable ANSI color. Defaults to auto-detect on TTY + `NO_COLOR`. */
  color?: boolean;
  /** Max table width. Defaults to `process.stderr.columns` if available, else 80. */
  width?: number;
}

/**
 * Render `issues` to stderr and terminate the process with code `1`.
 * Returns `never` because `process.exit` doesn't return — keeps
 * downstream type-narrowing honest.
 */
export function writeFailFast(
  issues: readonly ConfigDiagnostic[],
  options: WriteFailFastOptions = {},
): never {
  const stderr =
    options.stderr ?? (process.stderr as { write(chunk: string): unknown; isTTY?: boolean });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const color = resolveColor(options.color, stderr);
  const width = options.width ?? resolveWidth();

  const rendered = formatDiagnostics(issues, { color, width });
  stderr.write(rendered);
  exit(1);
  // `exit` is declared `never` on the public interface but TS can't
  // always narrow through the `??` fallback when `process.exit`'s
  // inferred return varies by ambient types — the explicit throw
  // here is unreachable in practice but keeps the function's `never`
  // return type honest for the type checker.
  throw new Error("writeFailFast: exit hook returned");
}

function resolveColor(
  color: boolean | undefined,
  stderr: { isTTY?: boolean },
): boolean {
  if (typeof color === "boolean") return color;
  if (process.env["NO_COLOR"] !== undefined) return false;
  return stderr.isTTY === true;
}

function resolveWidth(): number {
  const columns = (process.stderr as { columns?: number }).columns;
  if (typeof columns === "number" && columns >= 60) return columns;
  return 80;
}
