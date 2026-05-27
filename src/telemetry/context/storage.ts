/**
 * `AsyncLocalStorage`-backed context store. Every logger, meter, and
 * tracer in `forge/telemetry` reads from this single store so a record
 * emitted deep inside a request handler automatically carries the
 * request's trace ids and baggage.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { genSpanId, genTraceId } from "./ids";
import { TRACE_FLAGS, type TelemetryContext } from "./types";

/**
 * Process-wide ALS store. Exported so other subsystems (`log`, `meter`,
 * `trace`) read from the same singleton.
 *
 * Consumers usually do **not** call `contextStorage.run(...)` directly —
 * use {@link withContext} or {@link withRootContext} instead.
 */
export const contextStorage: AsyncLocalStorage<TelemetryContext> =
  new AsyncLocalStorage<TelemetryContext>();

/**
 * Return the active context, or `undefined` if no context is active on
 * the current async stack.
 */
export function currentContext(): TelemetryContext | undefined {
  return contextStorage.getStore();
}

/**
 * Run `fn` inside a context. Pass a complete {@link TelemetryContext} to
 * adopt an externally-extracted context (e.g. one parsed from an
 * incoming `traceparent` header), or pass a partial object to inherit
 * unspecified fields from the active context.
 *
 * If no active context exists and `ctx` is partial, the missing required
 * fields (`traceId`, `spanId`, `traceFlags`, `baggage`) are filled with
 * sensible defaults — a fresh trace id, a fresh span id, the SAMPLED
 * flag, and an empty baggage map.
 *
 * @example Adopt an extracted context for the lifetime of `handler()`
 * ```ts
 * const ctx = extractTraceparent(headers["traceparent"]);
 * await withContext(ctx, () => handler(request));
 * ```
 *
 * @example Add baggage to an existing context
 * ```ts
 * await withContext({ baggage: { tenantId: "acme" } }, async () => {
 *   await doWork();
 * });
 * ```
 */
export function withContext<T>(
  ctx: Partial<TelemetryContext>,
  fn: () => T,
): T {
  const parent = currentContext();
  const merged: TelemetryContext = parent
    ? mergeContext(parent, ctx)
    : freshContext(ctx);
  return contextStorage.run(merged, fn);
}

/**
 * Run `fn` inside a brand-new root context. Always allocates a fresh
 * trace id and span id; any partial fields in `seed` (such as
 * `baggage`) are honored.
 *
 * Useful at request entry points where you want to start a new trace
 * regardless of whether one was inherited from an enclosing context.
 */
export function withRootContext<T>(
  seed: Partial<Omit<TelemetryContext, "traceId" | "spanId" | "parentId">>,
  fn: () => T,
): T {
  const ctx: TelemetryContext = {
    traceId: genTraceId(),
    spanId: genSpanId(),
    traceFlags: seed.traceFlags ?? TRACE_FLAGS.SAMPLED,
    baggage: { ...(seed.baggage ?? {}) },
    ...(seed.traceState !== undefined ? { traceState: seed.traceState } : {}),
  };
  return contextStorage.run(ctx, fn);
}

function freshContext(seed: Partial<TelemetryContext>): TelemetryContext {
  return {
    traceId: seed.traceId ?? genTraceId(),
    spanId: seed.spanId ?? genSpanId(),
    traceFlags: seed.traceFlags ?? TRACE_FLAGS.SAMPLED,
    baggage: { ...(seed.baggage ?? {}) },
    ...(seed.parentId !== undefined ? { parentId: seed.parentId } : {}),
    ...(seed.traceState !== undefined ? { traceState: seed.traceState } : {}),
  };
}

function mergeContext(
  parent: TelemetryContext,
  override: Partial<TelemetryContext>,
): TelemetryContext {
  const baggage = override.baggage
    ? { ...parent.baggage, ...override.baggage }
    : parent.baggage;

  const merged: TelemetryContext = {
    traceId: override.traceId ?? parent.traceId,
    spanId: override.spanId ?? parent.spanId,
    traceFlags: override.traceFlags ?? parent.traceFlags,
    baggage,
  };

  const parentId = override.parentId ?? parent.parentId;
  if (parentId !== undefined) {
    (merged as { parentId?: string }).parentId = parentId;
  }
  const traceState = override.traceState ?? parent.traceState;
  if (traceState !== undefined) {
    (merged as { traceState?: string }).traceState = traceState;
  }
  return merged;
}
