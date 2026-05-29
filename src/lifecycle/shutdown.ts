/**
 * Reverse-order shutdown with per-component timeout slices.
 *
 * Components stop in strict reverse of start order. The global
 * `shutdownTimeout` is a hard budget: each remaining component receives an even
 * slice of the *remaining* budget, so one slow `stop()` cannot starve the
 * others and the whole sequence is bounded. A component that overruns its slice
 * is abandoned (recorded, not thrown) and shutdown proceeds.
 *
 * The same routine backs boot rollback (stopping the components that did start
 * before a later `start()` failed).
 *
 * @module
 */

import { ShutdownError, ShutdownTimeoutError } from "./errors";
import {
  type LifecycleMetrics,
  createLifecycleMetrics,
  now,
  withSpan,
} from "./observability";
import { componentLogger, runPhase } from "./phase";
import type { Clock, Component, Logger, TracerLike } from "./types";

/** Outcome of a reverse-order stop sequence. */
export interface StopResult {
  /** Errors from components whose `stop()` threw. */
  readonly errors: readonly ShutdownError[];
  /** Components abandoned after overrunning their stop slice. */
  readonly timeouts: readonly ShutdownTimeoutError[];
}

/** Inputs for {@link stopComponents}. */
export interface StopOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  /** Total budget, in ms, for the entire reverse-stop sequence. */
  readonly shutdownTimeout: number;
  /** `lifecycle.*` instruments. A no-op set is built when omitted. */
  readonly metrics?: LifecycleMetrics;
  /** Tracer for per-component stop spans. No spans are opened when omitted. */
  readonly tracer?: TracerLike;
}

/**
 * Stop `started` components in strict reverse order within `shutdownTimeout`.
 * Never rejects: failures and timeouts are collected and returned so the caller
 * can decide the exit code.
 */
export async function stopComponents(
  started: readonly Component[],
  opts: StopOptions,
): Promise<StopResult> {
  const { logger, clock, shutdownTimeout } = opts;
  const metrics = opts.metrics ?? createLifecycleMetrics();
  const tracer = opts.tracer;
  const errors: ShutdownError[] = [];
  const timeouts: ShutdownTimeoutError[] = [];

  // Only components that actually implement `stop`, in reverse start order.
  const stoppable = started
    .filter((c): c is Component & { stop: NonNullable<Component["stop"]> } =>
      typeof c.stop === "function",
    )
    .reverse();

  const deadline = clock.now() + shutdownTimeout;

  for (let i = 0; i < stoppable.length; i++) {
    const component = stoppable[i]!;
    const remainingCount = stoppable.length - i;
    const remainingBudget = Math.max(0, deadline - clock.now());
    const slice = remainingBudget / remainingCount;
    const log = componentLogger(logger, component.name);

    if (slice <= 0) {
      const err = new ShutdownTimeoutError(
        `component "${component.name}" abandoned: shutdown budget exhausted`,
        { component: component.name, timeoutMs: 0 },
      );
      timeouts.push(err);
      metrics.stopTimeout.add(1, { component: component.name });
      metrics.stopDuration.record(0, {
        component: component.name,
        outcome: "timeout",
      });
      log.warn("lifecycle.component.stop.timeout", {
        component: component.name,
        timeoutMs: 0,
      });
      continue;
    }

    log.debug("lifecycle.component.stop.start", { component: component.name });
    const stoppedAt = now();
    const outcome = await withSpan(
      tracer,
      "lifecycle.component.stop",
      { kind: "internal", attributes: { component: component.name } },
      () => runPhase((ctx) => component.stop(ctx), log, slice, clock),
    );
    const stopOutcome =
      outcome.kind === "ok" ? "ok" : outcome.kind === "timeout" ? "timeout" : "error";
    metrics.stopDuration.record(now() - stoppedAt, {
      component: component.name,
      outcome: stopOutcome,
    });

    if (outcome.kind === "timeout") {
      metrics.stopTimeout.add(1, { component: component.name });
      const err = new ShutdownTimeoutError(
        `component "${component.name}" exceeded its ${Math.round(slice)}ms stop slice and was abandoned`,
        { component: component.name, timeoutMs: slice },
      );
      timeouts.push(err);
      log.warn("lifecycle.component.stop.timeout", {
        component: component.name,
        timeoutMs: slice,
      });
    } else if (outcome.kind === "error") {
      const err = new ShutdownError(
        `component "${component.name}" failed to stop cleanly`,
        { component: component.name, cause: outcome.error },
      );
      errors.push(err);
      log.error("lifecycle.component.stop.error", {
        component: component.name,
        error: String(outcome.error),
      });
    } else {
      log.debug("lifecycle.component.stop.done", { component: component.name });
    }
  }

  return { errors, timeouts };
}
