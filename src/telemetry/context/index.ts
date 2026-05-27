/**
 * Telemetry context propagation — the foundation every other subsystem
 * in `forge/telemetry` builds on.
 *
 * A {@link TelemetryContext} carries a W3C-compatible trace id, span
 * id, and baggage. It rides through async code via Node's
 * `AsyncLocalStorage` so logs/metrics/traces emitted deep in a call
 * stack automatically carry the originating request's identifiers
 * without explicit parameter threading.
 *
 * @example Start a root context at request entry
 * ```ts
 * import { withRootContext } from "forge/telemetry/context";
 *
 * await withRootContext({ baggage: { tenantId: req.tenantId } }, async () => {
 *   await handler(req);
 * });
 * ```
 *
 * @example Adopt an extracted context from headers
 * ```ts
 * import { extract, objectCarrier, withContext } from "forge/telemetry/context";
 *
 * const ctx = extract(objectCarrier(req.headers));
 * if (ctx) {
 *   await withContext(ctx, () => handler(req));
 * }
 * ```
 *
 * @module
 */

export { genSpanId, genTraceId, INVALID_SPAN_ID, INVALID_TRACE_ID, isValidSpanId, isValidTraceId } from "./ids";
export {
  contextStorage,
  currentContext,
  withContext,
  withRootContext,
} from "./storage";
export {
  extract,
  formatBaggage,
  formatTraceparent,
  inject,
  objectCarrier,
  parseBaggage,
  parseTraceparent,
} from "./propagation";
export type { TextMapCarrier } from "./propagation";
export { TRACE_FLAGS } from "./types";
export type { TelemetryContext } from "./types";
