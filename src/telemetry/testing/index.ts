/**
 * Top-level test utilities for `forge/telemetry` consumers.
 *
 * `createTestTelemetry` wires {@link initTelemetry} with in-memory
 * recording exporters for all three signals and exposes them on the
 * returned handle. This is the recommended starting point for any
 * code that emits log/metric/span data — drop it in, run your code
 * under test, then assert against `handle.records` / `handle.batches`
 * / `handle.spans`.
 *
 * @example
 * ```ts
 * import { createTestTelemetry } from "forge/telemetry/testing";
 *
 * const t = createTestTelemetry();
 * t.log!.info("hi");
 * await t.flushAll();
 * expect(t.records).toHaveLength(1);
 * ```
 *
 * @module
 */

import { recordingExporter } from "../log/exporters/recording";
import type { RecordingExporter } from "../log/exporters/recording";
import { recordingMeterExporter } from "../meter/exporters/recording";
import type { RecordingMeterExporter } from "../meter/exporters/recording";
import { recordingSpanExporter } from "../trace/exporters/recording";
import type { RecordingSpanExporter } from "../trace/exporters/recording";
import { initTelemetry } from "../init";
import type {
  InitTelemetryLogOptions,
  InitTelemetryMeterOptions,
  InitTelemetryTraceOptions,
  Telemetry,
} from "../init";
import type { Resource } from "../types";

export interface TestTelemetryOptions {
  resource?: Resource;
  /**
   * Override the log section before it is wired. The recording
   * exporter is injected after this hook so you cannot replace it
   * — use it to set `level`, `attributes`, or middleware.
   */
  log?: Omit<InitTelemetryLogOptions, "exporter">;
  meter?: Omit<InitTelemetryMeterOptions, "exporter">;
  trace?: Omit<InitTelemetryTraceOptions, "exporter">;
  /**
   * Skip wiring the log signal. Defaults to `false`. Pass `true` when
   * you want a telemetry handle that exposes only meter/trace.
   */
  disableLog?: boolean;
  disableMeter?: boolean;
  disableTrace?: boolean;
}

export interface TestTelemetry extends Telemetry {
  readonly logExporter: RecordingExporter | undefined;
  readonly meterExporter: RecordingMeterExporter | undefined;
  readonly spanExporter: RecordingSpanExporter | undefined;
  /** Convenience: every recorded log record so far. */
  readonly records: ReturnType<() => RecordingExporter["records"]>;
  /** Convenience: every recorded metric batch so far. */
  readonly batches: ReturnType<() => RecordingMeterExporter["batches"]>;
  /** Convenience: every recorded finished span so far. */
  readonly spans: ReturnType<() => RecordingSpanExporter["spans"]>;
  /** Reset all in-memory buffers without tearing down the instances. */
  reset(): void;
  /** Force-collect the meter, then drain log + trace queues. */
  flushAll(): Promise<void>;
}

const DEFAULT_RESOURCE: Resource = {
  serviceName: "test",
  serviceVersion: "0.0.0",
  environment: "test",
};

export function createTestTelemetry(
  options: TestTelemetryOptions = {},
): TestTelemetry {
  const resource = options.resource ?? DEFAULT_RESOURCE;

  const logExporter = options.disableLog ? undefined : recordingExporter();
  const meterExporter = options.disableMeter ? undefined : recordingMeterExporter();
  const spanExporter = options.disableTrace ? undefined : recordingSpanExporter();

  const base = initTelemetry({
    resource,
    log: logExporter
      ? { ...(options.log ?? {}), exporter: logExporter }
      : undefined,
    meter: meterExporter
      ? {
          ...(options.meter ?? {}),
          exporter: meterExporter,
          // Disable the background timer so tests have deterministic
          // collection: callers explicitly `await flushAll()` or
          // `await t.meter!.collect()`.
          intervalMs: options.meter?.intervalMs ?? 0,
        }
      : undefined,
    trace: spanExporter
      ? {
          ...(options.trace ?? {}),
          exporter: spanExporter,
          // Simple processor is synchronous-ish — ideal for tests
          // because spans appear in `spans` immediately on `span.end()`.
          processor: options.trace?.processor ?? "simple",
        }
      : undefined,
  });

  return {
    ...base,
    logExporter,
    meterExporter,
    spanExporter,
    get records() {
      return logExporter?.records ?? [];
    },
    get batches() {
      return meterExporter?.batches ?? [];
    },
    get spans() {
      return spanExporter?.spans ?? [];
    },
    reset() {
      logExporter?.reset();
      meterExporter?.reset();
      spanExporter?.reset();
    },
    async flushAll() {
      // `base.flush()` already calls `meter.flush()` which internally
      // collects, so we don't need a separate `meter.collect()` first
      // — that would double-emit a batch.
      await base.flush();
    },
  };
}
