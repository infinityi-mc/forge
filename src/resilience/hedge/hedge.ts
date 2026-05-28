/**
 * `hedge` — fire speculative parallel attempts and return the first
 * to succeed.
 *
 * Useful when a small fraction of upstream calls run *much* slower
 * than the median (long-tail latency). Firing a second request after
 * a short delay reduces tail latency without doubling load on the
 * happy path. Losing attempts are cancelled via their own
 * `AbortSignal` — pass `ctx.signal` to `fetch`, `bun:sqlite`, or any
 * cooperating I/O so the cancellation actually closes the socket.
 *
 * Schedule:
 *   - Attempt 1 fires immediately.
 *   - Attempt 2 fires after `delay` ms (if attempt 1 hasn't settled).
 *   - Attempt 3 after another `delay` ms, etc.
 *   - Up to `maxHedgedAttempts` attempts run concurrently.
 *
 * Resolution:
 *   - First attempt to succeed wins; the others are aborted with a
 *     {@link HedgeCancelledError}.
 *   - If every launched attempt fails, the last error is thrown.
 *   - If the parent `ctx.signal` aborts, every in-flight attempt is
 *     aborted with the parent's reason and the policy rethrows it.
 *
 * `maxHedgedAttempts: 1` is a passthrough — handy when hedging is
 * conditionally enabled via configuration without restructuring the
 * pipeline.
 *
 * @module
 */

import { realClock } from "../clock";
import { withExecutionContext } from "../context";
import { buildInstruments } from "../telemetry/instrumentation";
import type { Clock, ExecutionContext, Operation } from "../types";
import { HedgeCancelledError } from "./errors";
import type { HedgeOptions, HedgePolicy } from "./types";

/**
 * Create a hedge policy.
 *
 * @example
 * ```ts
 * import { combine, hedge, timeout } from "forge/resilience";
 *
 * const pipeline = combine(
 *   hedge({ delay: 50, maxHedgedAttempts: 3 }),
 *   timeout({ ms: 2_000 }),
 * );
 *
 * await pipeline.execute(async (ctx) => {
 *   return fetch(url, { signal: ctx.signal });
 * });
 * ```
 */
export function hedge(options: HedgeOptions): HedgePolicy {
  if (!Number.isFinite(options.delay) || options.delay < 0) {
    throw new RangeError(
      `hedge: delay must be a finite non-negative number, got ${options.delay}`,
    );
  }
  if (
    !Number.isInteger(options.maxHedgedAttempts) ||
    options.maxHedgedAttempts < 1
  ) {
    throw new RangeError(
      `hedge: maxHedgedAttempts must be an integer >= 1, got ${options.maxHedgedAttempts}`,
    );
  }

  const delay = options.delay;
  const maxHedgedAttempts = options.maxHedgedAttempts;
  const clock: Clock = options.clock ?? realClock;
  const instruments = buildInstruments(options.telemetry);

  async function execute<T>(
    next: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    if (ctx.signal.aborted) throw ctx.signal.reason;

    // Single-attempt passthrough — skip all the fanout machinery.
    if (maxHedgedAttempts === 1) {
      instruments.attempts()?.add(1, { policy: "hedge" });
      return next(ctx);
    }

    const childControllers: AbortController[] = [];
    const scheduleController = new AbortController();
    const errors: unknown[] = [];
    let settled = false;
    let launchedCount = 0;

    let resolveOuter!: (value: T) => void;
    let rejectOuter!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    const onParentAbort = (): void => {
      settle("reject", ctx.signal.reason);
    };
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    function settle(
      kind: "resolve" | "reject",
      payload: unknown,
      winnerController?: AbortController,
    ): void {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onParentAbort);
      const cancelReason =
        kind === "resolve" ? new HedgeCancelledError() : payload;
      if (!scheduleController.signal.aborted) {
        scheduleController.abort(cancelReason);
      }
      for (const ac of childControllers) {
        if (ac === winnerController) continue;
        if (!ac.signal.aborted) ac.abort(cancelReason);
      }
      if (kind === "resolve") {
        resolveOuter(payload as T);
      } else {
        rejectOuter(payload);
      }
    }

    function launchOne(index: number): void {
      if (settled) return;
      const ac = new AbortController();
      childControllers.push(ac);
      launchedCount++;
      const childCtx = withExecutionContext(ctx, { signal: ac.signal });
      instruments.attempts()?.add(1, { policy: "hedge" });
      instruments.addEvent("resilience.hedge.attempt", {
        attempt_index: index,
      });

      Promise.resolve()
        .then(() => next(childCtx))
        .then(
          (value) => settle("resolve", value, ac),
          (error) => {
            if (settled) return;
            errors.push(error);
            // All launched attempts have failed AND no more will be
            // launched → fail with the last error.
            if (
              errors.length === launchedCount &&
              launchedCount >= maxHedgedAttempts
            ) {
              settle("reject", error);
            }
          },
        );
    }

    // Schedule attempts. Runs as its own async fiber so failures of
    // already-launched attempts can race against the schedule.
    (async () => {
      launchOne(0);
      for (let i = 1; i < maxHedgedAttempts; i++) {
        if (settled) return;
        try {
          await clock.sleep(delay, scheduleController.signal);
        } catch {
          // The schedule is cancelled as soon as a winner settles or
          // the parent aborts. Either path has already settled the
          // outer promise, so just stop launching new attempts.
          return;
        }
        if (settled) return;
        launchOne(i);
      }
      // Safety belt: if every launched attempt has already failed by
      // the time the schedule completes, settle now. The per-attempt
      // rejection handler would normally cover this, but the very
      // last rejection might have arrived before launchedCount was
      // incremented for that same attempt — re-evaluating here
      // guarantees we don't hang.
      if (
        !settled &&
        errors.length === launchedCount &&
        launchedCount >= maxHedgedAttempts
      ) {
        settle("reject", errors[errors.length - 1]);
      }
    })().catch((error) => {
      // The scheduling fiber should never throw — it catches sleep
      // rejections and the launchOne body never throws. Re-route any
      // truly unexpected error rather than swallowing it.
      if (!settled) settle("reject", error);
    });

    return result;
  }

  return {
    name: "hedge",
    execute,
  };
}
