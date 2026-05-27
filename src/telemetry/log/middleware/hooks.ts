/**
 * Internal coordination hooks between built-in middleware. Middleware
 * that drops records (`sample`, `rateLimit`) reports drops through
 * these symbols so a downstream `telemetry({ onDrop })` middleware can
 * surface them.
 *
 * Consumers normally do not import from this file directly — they
 * install `telemetry()` middleware and supply `onDrop`/`onError` hooks.
 *
 * @module
 */

import type { LogExporter, LogRecord } from "../types";

export interface LogDropNotice {
  record: LogRecord;
  reason: "sample" | "rate-limit";
  middleware: string;
  metadata?: Record<string, unknown>;
}

export interface LogErrorNotice {
  record: LogRecord;
  error: unknown;
  middleware: string;
}

export const LOG_DROP_HOOK: unique symbol = Symbol.for(
  "forge.telemetry.log.dropHook",
) as never;

export const LOG_ERROR_HOOK: unique symbol = Symbol.for(
  "forge.telemetry.log.errorHook",
) as never;

export const LOG_ERROR_HANDLED: unique symbol = Symbol.for(
  "forge.telemetry.log.errorHandled",
) as never;

type HookedExporter = LogExporter & {
  [LOG_DROP_HOOK]?: (notice: LogDropNotice) => void;
  [LOG_ERROR_HOOK]?: (notice: LogErrorNotice) => void;
};

type HandledError = object & { [LOG_ERROR_HANDLED]?: true };
const handledPrimitiveErrors = new Set<unknown>();

export function notifyDrop(next: LogExporter, notice: LogDropNotice): void {
  (next as HookedExporter)[LOG_DROP_HOOK]?.(notice);
}

export function notifyError(next: LogExporter, notice: LogErrorNotice): void {
  (next as HookedExporter)[LOG_ERROR_HOOK]?.(notice);
}

export function markErrorHandled(error: unknown): void {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    try {
      (error as HandledError)[LOG_ERROR_HANDLED] = true;
    } catch {
      handledPrimitiveErrors.add(error);
      queueMicrotask(() => handledPrimitiveErrors.delete(error));
    }
    return;
  }
  handledPrimitiveErrors.add(error);
  queueMicrotask(() => handledPrimitiveErrors.delete(error));
}

export function isErrorHandled(error: unknown): boolean {
  if (handledPrimitiveErrors.has(error)) {
    handledPrimitiveErrors.delete(error);
    return true;
  }
  return (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    (error as HandledError)[LOG_ERROR_HANDLED] === true
  );
}
