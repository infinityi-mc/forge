/**
 * `timeout` — deadline-enforcing policy.
 *
 * Spawns a child {@link AbortController} linked to the parent
 * execution signal, runs the operation against the child signal, and
 * races it against a timer. When the timer wins, the child controller
 * is aborted (so cooperating I/O like `fetch` is cancelled at the
 * socket level — the spec's headline guarantee in §B) and a
 * {@link TimeoutError} is thrown.
 *
 * The `optimistic` strategy throws immediately when the timer fires;
 * the operation continues in the background until it observes the
 * abort. The `pessimistic` strategy aborts and waits for the
 * operation to settle before throwing, useful for code that may not
 * honor the abort.
 *
 * @module
 */

import { realClock } from "../clock";
import { withExecutionContext } from "../context";
import { buildInstruments } from "../telemetry/instrumentation";
import type {
  Clock,
  ExecutionContext,
  Operation,
} from "../types";
import { TimeoutError } from "./errors";
import type { TimeoutOptions, TimeoutPolicy } from "./types";

/**
 * Create a timeout policy.
 *
 * @example Optimistic (default) — abort and reject as soon as the
 * deadline fires.
 * ```ts
 * import { combine, timeout } from "forge/resilience";
 *
 * const pipeline = combine(timeout({ ms: 2_000 }));
 * await pipeline.execute(async (ctx) => {
 *   return fetch(url, { signal: ctx.signal });
 * });
 * ```
 *
 * @example Pessimistic — abort the inner signal but wait for the
 * operation to settle before rejecting.
 * ```ts
 * const pipeline = combine(timeout({ ms: 2_000, strategy: "pessimistic" }));
 * ```
 */
export function timeout(options: TimeoutOptions): TimeoutPolicy {
  if (!Number.isFinite(options.ms) || options.ms < 0) {
    throw new RangeError(
      `timeout: ms must be a finite non-negative number, got ${options.ms}`,
    );
  }

  const ms = options.ms;
  const strategy = options.strategy ?? "optimistic";
  const clock: Clock = options.clock ?? realClock;
  const instruments = buildInstruments(options.telemetry);

  async function execute<T>(
    next: Operation<T>,
    ctx: ExecutionContext,
  ): Promise<T> {
    // Child controller linked to the parent: if the caller aborts the
    // outer signal, the inner operation sees it too. If the timer
    // fires, only the child is aborted — the parent is left alone so
    // an outer `retry` can still schedule the next attempt.
    const inner = new AbortController();
    const onParentAbort = (): void => {
      inner.abort(ctx.signal.reason);
    };
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    const childCtx = withExecutionContext(ctx, { signal: inner.signal });

    // Timer signal — `clock.sleep` rejects when this aborts, which
    // lets `Promise.race` settle with the timer winner.
    const timerController = new AbortController();
    let timedOut = false;

    const timerPromise = clock.sleep(ms, timerController.signal).then(
      () => {
        // Sleep completed without being cancelled → deadline reached.
        timedOut = true;
        const err = new TimeoutError(
          `timeout: operation exceeded ${ms}ms`,
          { timeoutMs: ms, strategy },
        );
        inner.abort(err);
        instruments.timeouts()?.add(1, { policy: "timeout", strategy });
        instruments.addEvent("resilience.timeout.triggered", {
          timeout_ms: ms,
          strategy,
        });
        return err;
      },
      (reason: unknown) => {
        // Timer cancelled (operation finished first) — surface a
        // sentinel that `Promise.race` will see as a rejection of
        // the timer branch; the outer race won't observe it because
        // the operation will have resolved first.
        throw reason;
      },
    );

    let opSettled = false;
    const opPromise = (async () => {
      try {
        const value = await next(childCtx);
        opSettled = true;
        timerController.abort();
        return value;
      } catch (error) {
        opSettled = true;
        timerController.abort();
        throw error;
      }
    })();

    try {
      const winner = await Promise.race([
        opPromise.then((value) => ({ kind: "ok" as const, value })),
        timerPromise.then((err) => ({ kind: "timeout" as const, err })),
      ]);

      if (winner.kind === "ok") {
        return winner.value;
      }

      // Timer won. Pessimistic strategy waits for the operation to
      // settle before throwing — gives the operation a chance to
      // release resources after it observes the abort.
      if (strategy === "pessimistic") {
        try {
          await opPromise;
        } catch {
          // Operation's own error is swallowed in favor of the
          // timeout error — the deadline is the primary failure.
        }
      } else {
        // Optimistic strategy still attaches a `.catch` so the
        // background operation's eventual rejection doesn't surface
        // as an unhandled-rejection warning.
        opPromise.catch(() => {});
      }
      throw winner.err;
    } finally {
      ctx.signal.removeEventListener("abort", onParentAbort);
      if (!opSettled && !timedOut) {
        timerController.abort();
      }
    }
  }

  return {
    name: "timeout",
    ms,
    strategy,
    execute,
  };
}
