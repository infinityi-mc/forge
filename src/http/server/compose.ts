/**
 * Outermost-first middleware composition.
 *
 * `compose([a, b, c], handler)` returns `a(b(c(handler)))`: the first
 * middleware in the array sees the request first and the response last —
 * deliberately the same fold as `forge/resilience` `combine(...)` and the
 * `forge/telemetry/log` middleware stack. Folded once at build time so the
 * per-request hot path is just a function-call chain.
 *
 * @module
 */

import type { Handler, Middleware } from "../types";

/** Fold `middleware` around `handler`, outermost-first. */
export function compose(
  middleware: readonly Middleware[],
  handler: Handler,
): Handler {
  let chain: Handler = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    chain = middleware[i]!(chain);
  }
  return chain;
}
