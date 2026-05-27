/**
 * Reference exporter that writes log records to a process's standard
 * streams.
 *
 * Two output formats are supported:
 *
 * - `"pretty"` — human-readable, ANSI-colored, defaults on when stdout
 *   is a TTY.
 * - `"json"` — single-line JSON-per-record, defaults on when stdout
 *   is not a TTY (the typical container / log-shipping shape).
 *
 * Severity routing: by default `warn`, `error`, and `fatal` are written
 * to stderr; everything else to stdout. Override via
 * {@link StdoutExporterOptions.splitStreams}.
 *
 * @module
 */

import type { LogExporter, LogRecord } from "../../types";
import { formatJson, type JsonFormatOptions } from "./format-json";
import { formatPretty, type PrettyFormatOptions } from "./format-pretty";

export interface StdoutExporterOptions {
  /** Output format. Default: `"auto"` — pretty when stdout is a TTY, JSON otherwise. */
  format?: "pretty" | "json" | "auto";
  /**
   * Enable ANSI colors. Default: auto — `true` when stdout is a TTY
   * and `NO_COLOR` is unset. Ignored by the JSON formatter.
   */
  color?: boolean;
  /** Route `warn`/`error`/`fatal` records to stderr. Default: `true`. */
  splitStreams?: boolean;
  /** Override the stdout sink (typically for tests). */
  stdout?: { write(chunk: string): unknown; isTTY?: boolean };
  /** Override the stderr sink (typically for tests). */
  stderr?: { write(chunk: string): unknown; isTTY?: boolean };
  /** Pass-through options for the JSON formatter. */
  json?: JsonFormatOptions;
  /** Pass-through options for the pretty formatter. */
  pretty?: PrettyFormatOptions;
}

interface StreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/**
 * Create a stdout exporter.
 *
 * @example
 * ```ts
 * import { createLog } from "forge/telemetry/log";
 * import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";
 *
 * const log = createLog({ exporter: stdoutExporter({ format: "json" }) });
 * log.info("server started", { port: 3000 });
 * ```
 */
export function stdoutExporter(
  options: StdoutExporterOptions = {},
): LogExporter {
  const stdout: StreamLike = options.stdout ?? (process.stdout as StreamLike);
  const stderr: StreamLike = options.stderr ?? (process.stderr as StreamLike);
  const splitStreams = options.splitStreams ?? true;

  const resolvedFormat = resolveFormat(options.format, stdout);
  const resolvedColor =
    resolvedFormat === "pretty"
      ? { color: resolveColor(options.color, stdout), ...(options.pretty ?? {}) }
      : ({} as PrettyFormatOptions);

  const format = (record: LogRecord): string =>
    resolvedFormat === "pretty"
      ? formatPretty(record, resolvedColor)
      : formatJson(record, options.json);

  return {
    export(record) {
      const out = format(record);
      const sink =
        splitStreams &&
        (record.level === "warn" ||
          record.level === "error" ||
          record.level === "fatal")
          ? stderr
          : stdout;
      sink.write(out);
    },
  };
}

function resolveFormat(
  format: StdoutExporterOptions["format"],
  stdout: StreamLike,
): "pretty" | "json" {
  if (format === "pretty" || format === "json") return format;
  return stdout.isTTY ? "pretty" : "json";
}

function resolveColor(
  color: boolean | undefined,
  stdout: StreamLike,
): boolean {
  if (typeof color === "boolean") return color;
  // NO_COLOR standard — any presence of the env var disables color.
  if (process.env["NO_COLOR"] !== undefined) return false;
  return stdout.isTTY === true;
}
