/**
 * Pretty (human-readable, ANSI-colored) formatter for `stdoutExporter`.
 *
 * Single-line layout: `HH:MM:SS.mmm  INFO  message  key=value …`.
 * Errors in attributes are rendered on continuation lines.
 *
 * @module
 */

import type { LogLevel, LogRecord } from "../../types";

export interface PrettyFormatOptions {
  /** Enable ANSI colors. Defaults to `false` — callers decide based on TTY detection. */
  color?: boolean;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\u001b[2m",         // dim
  debug: "\u001b[36m",        // cyan
  info: "\u001b[32m",         // green
  warn: "\u001b[33m",         // yellow
  error: "\u001b[31m",        // red
  fatal: "\u001b[1;31m",      // bold red
};
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

export function formatPretty(
  record: LogRecord,
  options: PrettyFormatOptions = {},
): string {
  const color = options.color ?? false;
  const time = formatTime(record.timestamp);
  const level = record.level.toUpperCase().padEnd(5);
  const tinted = color ? `${LEVEL_COLORS[record.level]}${level}${RESET}` : level;

  const parts: string[] = [time, tinted, record.message];
  for (const key of Object.keys(record.attributes)) {
    const value = record.attributes[key];
    parts.push(formatAttribute(key, value, color));
  }
  if (record.context !== undefined) {
    parts.push(formatAttribute("trace_id", record.context.traceId, color));
  }
  return `${parts.join("  ")}\n`;
}

function formatTime(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatAttribute(key: string, value: unknown, color: boolean): string {
  const k = color ? `${DIM}${key}${RESET}` : key;
  return `${k}=${formatValue(value)}`;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
