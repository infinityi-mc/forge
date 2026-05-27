/**
 * Helpers for building and refining {@link ExecutionContext}s.
 *
 * The root context for a `pipeline.execute(...)` call is built by
 * {@link buildRootContext}: it allocates a fresh `AbortController`,
 * reads the active telemetry context (if any), and stamps
 * `attempt: 1`. Policies that change one slot of the context — `retry`
 * incrementing `attempt`, `timeout` swapping in a narrower
 * `AbortSignal` — call {@link withContext} to produce a shallow
 * descendant.
 *
 * @module
 */

import { currentContext } from "../telemetry/context/storage";
import type { ExecutionContext } from "./types";

/**
 * Build the root {@link ExecutionContext} for a pipeline execution.
 * Allocates a fresh `AbortController` so an outer `timeout` or
 * `hedge` policy can later abort the operation, and reads the active
 * telemetry context so trace events emitted inside policies can
 * inherit the request's trace ids.
 */
export function buildRootContext(): {
  context: ExecutionContext;
  controller: AbortController;
} {
  const controller = new AbortController();
  const telemetry = currentContext();
  const context: ExecutionContext = telemetry
    ? { signal: controller.signal, attempt: 1, context: telemetry }
    : { signal: controller.signal, attempt: 1 };
  return { context, controller };
}

/**
 * Return a new {@link ExecutionContext} with `overrides` merged on
 * top. Fields not present in `overrides` are inherited verbatim. The
 * optional `context` slot is preserved unless explicitly overridden.
 */
export function withExecutionContext(
  base: ExecutionContext,
  overrides: Partial<ExecutionContext>,
): ExecutionContext {
  const next: ExecutionContext = {
    signal: overrides.signal ?? base.signal,
    attempt: overrides.attempt ?? base.attempt,
  };
  const telemetry =
    "context" in overrides ? overrides.context : base.context;
  if (telemetry !== undefined) {
    (next as { context?: ExecutionContext["context"] }).context = telemetry;
  }
  return next;
}
