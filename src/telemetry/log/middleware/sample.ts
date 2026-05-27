/**
 * Sampling middleware. Drops records according to a configurable
 * keep-rate. Supports per-level overrides and either deterministic
 * (hash-based) or random sampling.
 *
 * @module
 */

import type { LogLevel, LogMiddleware, LogRecord } from "../types";
import { notifyDrop } from "./hooks";

export interface SampleOptions {
  /** Global keep rate in `[0, 1]`. Defaults to `1` (keep everything). */
  rate?: number;
  /** Per-level overrides — e.g. `{ debug: 0.1 }` keeps 10% of debug records. */
  perSeverity?: Partial<Record<LogLevel, number>>;
  /**
   * Time bucket (ms) for deterministic sampling. The hash input
   * includes `floor(timestamp / bucketMs)` so identical records inside
   * the same bucket get the same decision.
   */
  bucketMs?: number;
  /** Use `Math.random()` instead of deterministic hashing. */
  random?: boolean;
  /** Override the random source for tests. */
  randomSource?: () => number;
}

export function sample(options: SampleOptions = {}): LogMiddleware {
  const rate = validateRate(options.rate ?? 1, "rate");
  const perSeverity: Partial<Record<LogLevel, number>> = {};
  for (const [level, value] of Object.entries(options.perSeverity ?? {}) as [
    LogLevel,
    number,
  ][]) {
    perSeverity[level] = validateRate(value, `perSeverity.${level}`);
  }
  const bucketMs = options.bucketMs ?? 60_000;
  if (bucketMs <= 0) throw new Error("sample: bucketMs must be > 0");
  const random = options.random ?? false;
  const randomSource = options.randomSource ?? Math.random;

  return (next) => ({
    export(record) {
      const keepRate = perSeverity[record.level] ?? rate;
      if (keepRate >= 1) {
        next.export(record);
        return;
      }
      if (
        keepRate <= 0 ||
        score(record, bucketMs, random, randomSource) >= keepRate
      ) {
        notifyDrop(next, {
          record,
          reason: "sample",
          middleware: "sample",
          metadata: { rate: keepRate },
        });
        return;
      }
      next.export(record);
    },
  });
}

function validateRate(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`sample: ${name} must be between 0 and 1`);
  }
  return value;
}

function score(
  record: LogRecord,
  bucketMs: number,
  random: boolean,
  randomSource: () => number,
): number {
  if (random) return randomSource();
  const bucket = Math.floor(record.timestamp.getTime() / bucketMs);
  return hashToUnit(`${record.level}\0${record.message}\0${bucket}`);
}

function hashToUnit(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}
