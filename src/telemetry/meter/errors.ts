/**
 * Typed errors for `forge/telemetry/meter`.
 *
 * @module
 */

import { TelemetryError } from "../errors";
import type { MetricBatch } from "./types";

export class MeterError extends TelemetryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MeterError";
  }
}

export class MeterExporterError extends MeterError {
  readonly batch?: MetricBatch;

  constructor(message: string, options?: ErrorOptions & { batch?: MetricBatch }) {
    super(message, options);
    this.name = "MeterExporterError";
    if (options?.batch !== undefined) {
      this.batch = options.batch;
    }
  }
}

/**
 * The caller passed a negative delta to a monotonic instrument or
 * an `NaN`/non-finite value to any numeric instrument.
 */
export class MeterValueError extends MeterError {
  /** Instrument descriptor's name, when known. */
  readonly instrument?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { instrument?: string },
  ) {
    super(message, options);
    this.name = "MeterValueError";
    if (options?.instrument !== undefined) {
      this.instrument = options.instrument;
    }
  }
}
