/**
 * Telemetry-of-telemetry middleware. Observes successful writes, drops
 * (reported by `sample`/`rateLimit`), and exporter errors via consumer-
 * supplied hooks — typically to increment counters or emit metrics.
 *
 * Place after droppers in the middleware array if you want `onDrop`
 * events: `[redact(), sample(), rateLimit(), telemetry({ … })]`.
 *
 * @module
 */

import type { LogMiddleware, LogRecord } from "../types";
import {
  LOG_DROP_HOOK,
  LOG_ERROR_HOOK,
  markErrorHandled,
  type LogDropNotice,
  type LogErrorNotice,
} from "./hooks";

export interface LogTelemetryHooks {
  onWrite?: (info: { record: LogRecord; durationMs: number }) => void;
  onDrop?: (info: LogDropNotice) => void;
  onError?: (info: LogErrorNotice & { durationMs: number }) => void;
}

export function telemetry(hooks: LogTelemetryHooks): LogMiddleware {
  return (next) => ({
    export(record) {
      const startedAt = Date.now();
      try {
        next.export(record);
        callHook(() =>
          hooks.onWrite?.({ record, durationMs: Date.now() - startedAt }),
        );
      } catch (error) {
        markErrorHandled(error);
        callHook(() =>
          hooks.onError?.({
            record,
            error,
            middleware: "telemetry",
            durationMs: Date.now() - startedAt,
          }),
        );
        throw error;
      }
    },
    [LOG_DROP_HOOK](notice: LogDropNotice) {
      callHook(() => hooks.onDrop?.(notice));
    },
    [LOG_ERROR_HOOK](notice: LogErrorNotice) {
      callHook(() => hooks.onError?.({ ...notice, durationMs: 0 }));
    },
  });
}

function callHook(invoke: () => void): void {
  try {
    invoke();
  } catch {
    // Telemetry hooks are observational; hook failures must not alter
    // logger control flow or replace the original exporter error.
  }
}
