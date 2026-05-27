/**
 * Typed errors for `forge/telemetry/trace`.
 *
 * @module
 */

import { TelemetryError } from "../errors";
import type { ReadableSpan } from "./types";

export class TraceError extends TelemetryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TraceError";
  }
}

export class SpanExporterError extends TraceError {
  readonly spans?: readonly ReadableSpan[];
  constructor(
    message: string,
    options?: ErrorOptions & { spans?: readonly ReadableSpan[] },
  ) {
    super(message, options);
    this.name = "SpanExporterError";
    if (options?.spans !== undefined) {
      this.spans = options.spans;
    }
  }
}
