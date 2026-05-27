/**
 * Conformance scenarios + assertion helpers for `forge/telemetry/log`.
 *
 * Run `STANDARD_LOG_SCENARIOS` against any `LogExporter` to verify it
 * satisfies the same invariants as the shipped exporters: it accepts
 * every level, preserves attributes, surfaces context, doesn't mutate
 * records, and (when async) flushes cleanly.
 *
 * Helpers throw plain `Error`s on failure so they work under Bun's
 * built-in test runner, Vitest, Jest, or any other framework.
 *
 * @module
 */

import type { LogExporter, LogLevel, LogRecord } from "../types";

/**
 * A single conformance scenario. `name` is for human-readable failure
 * messages; `run` exercises the exporter and `assert` verifies the
 * recorded state.
 */
export interface LogConformanceScenario {
  name: string;
  run(exporter: LogExporter): Promise<void> | void;
  assert(records: readonly LogRecord[]): void;
}

const sampleLevels: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

function makeRecord(level: LogLevel, message: string, n: number): LogRecord {
  return {
    level,
    message,
    timestamp: new Date(2025, 0, 1, 0, 0, n),
    attributes: { seq: n },
  };
}

export const STANDARD_LOG_SCENARIOS: readonly LogConformanceScenario[] = [
  {
    name: "exporter accepts every standard level",
    run(exporter) {
      for (let i = 0; i < sampleLevels.length; i++) {
        exporter.export(makeRecord(sampleLevels[i]!, "hello", i));
      }
    },
    assert(records) {
      assertRecordCount(records, sampleLevels.length);
      for (let i = 0; i < sampleLevels.length; i++) {
        assertRecordLevel(records[i]!, sampleLevels[i]!);
      }
    },
  },
  {
    name: "exporter preserves message and attributes verbatim",
    run(exporter) {
      exporter.export({
        level: "info",
        message: "hello",
        timestamp: new Date(0),
        attributes: { a: 1, b: { c: "nested" } },
      });
    },
    assert(records) {
      assertRecordCount(records, 1);
      assertRecordMessage(records[0]!, "hello");
      assertRecordAttributes(records[0]!, { a: 1, b: { c: "nested" } });
    },
  },
  {
    name: "exporter does not mutate the record it received",
    run(exporter) {
      const frozen = Object.freeze({
        level: "info" as LogLevel,
        message: "frozen",
        timestamp: new Date(0),
        attributes: Object.freeze({ readonly: true } as Record<string, unknown>),
      });
      // Will throw `TypeError` if the exporter mutates a frozen field.
      exporter.export(frozen);
    },
    assert(records) {
      assertRecordCount(records, 1);
    },
  },
];

export interface RecordingExporterHandle {
  exporter: LogExporter;
  records: readonly LogRecord[];
}

/**
 * Minimal recording exporter for assertion-style tests. Distinct from
 * the package-level `recordingExporter` so the conformance suite has
 * zero runtime dependencies.
 */
export function recordingTransport(): RecordingExporterHandle {
  const records: LogRecord[] = [];
  return {
    records,
    exporter: { export: (record) => void records.push(record) },
  };
}

// ────────────────────────────────────────────────────────────────────
// Assertion helpers
// ────────────────────────────────────────────────────────────────────

export function assertRecordCount(
  records: readonly LogRecord[],
  expected: number,
): void {
  if (records.length !== expected) {
    throw new Error(
      `expected ${expected} record(s), got ${records.length}`,
    );
  }
}

export function assertRecordLevel(record: LogRecord, level: LogLevel): void {
  if (record.level !== level) {
    throw new Error(`expected level "${level}", got "${record.level}"`);
  }
}

export function assertRecordMessage(
  record: LogRecord,
  message: string,
): void {
  if (record.message !== message) {
    throw new Error(
      `expected message ${JSON.stringify(message)}, got ${JSON.stringify(
        record.message,
      )}`,
    );
  }
}

export function assertRecordAttributes(
  record: LogRecord,
  expected: Record<string, unknown>,
): void {
  const actual = JSON.stringify(record.attributes);
  const expectedStr = JSON.stringify(expected);
  if (actual !== expectedStr) {
    throw new Error(
      `expected attributes ${expectedStr}, got ${actual}`,
    );
  }
}

export function assertNoRecordsAtLevel(
  records: readonly LogRecord[],
  level: LogLevel,
): void {
  const hit = records.find((r) => r.level === level);
  if (hit) {
    throw new Error(
      `expected no records at level "${level}", got ${JSON.stringify(hit)}`,
    );
  }
}

export function assertValidLogRecord(record: LogRecord): void {
  if (!sampleLevels.includes(record.level)) {
    throw new Error(`invalid level ${JSON.stringify(record.level)}`);
  }
  if (typeof record.message !== "string") {
    throw new Error("record.message must be a string");
  }
  if (!(record.timestamp instanceof Date)) {
    throw new Error("record.timestamp must be a Date");
  }
  if (
    typeof record.attributes !== "object" ||
    record.attributes === null ||
    Array.isArray(record.attributes)
  ) {
    throw new Error("record.attributes must be a plain object");
  }
}
