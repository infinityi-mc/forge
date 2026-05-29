/**
 * Internal helpers shared by {@link boot} and the shutdown sequence: a silent
 * fallback logger, per-component child-logger derivation, and {@link runPhase} —
 * the bounded runner that executes a single `start`/`stop` under an
 * `AbortSignal` and reports whether it completed, threw, or overran its slice.
 *
 * @module
 */

import type { Clock, LifecycleContext, Logger } from "./types";

/** A logger that drops everything. Used when no logger handle is injected. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/**
 * Derive a per-component logger. Uses the handle's `child()` when available
 * (so attributes propagate) and otherwise returns the parent unchanged.
 */
export function componentLogger(logger: Logger, component: string): Logger {
  return logger.child ? logger.child({ component }) : logger;
}

/** The result of running a single bounded phase. */
export type PhaseOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

/**
 * Run a single component phase under a timeout.
 *
 * The operation receives a {@link LifecycleContext} whose `signal` aborts when
 * the slice elapses. If the operation finishes (or throws) first, its outcome
 * is returned and the pending timer is cancelled. If the slice elapses first
 * the phase is reported as `timeout`, the signal is aborted (so a cooperating
 * operation can cancel), and the abandoned promise is detached so it cannot
 * surface as an unhandled rejection.
 *
 * A non-positive or non-finite `timeoutMs` means "no timeout".
 */
export async function runPhase(
  op: (ctx: LifecycleContext) => Promise<void> | void,
  logger: Logger,
  timeoutMs: number,
  clock: Clock,
): Promise<PhaseOutcome> {
  const phaseCtl = new AbortController();
  const ctx: LifecycleContext = { signal: phaseCtl.signal, logger };

  const opPromise: Promise<PhaseOutcome> = (async () => {
    try {
      await op(ctx);
      return { kind: "ok" };
    } catch (error) {
      return { kind: "error", error };
    }
  })();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return opPromise;
  }

  const sleepCtl = new AbortController();
  const timeoutPromise: Promise<PhaseOutcome | null> = clock
    .sleep(timeoutMs, sleepCtl.signal)
    .then(
      (): PhaseOutcome => ({ kind: "timeout" }),
      (): null => null,
    );

  const winner = await Promise.race([opPromise, timeoutPromise]);

  if (winner !== null && winner.kind === "timeout") {
    phaseCtl.abort(new Error("lifecycle phase timed out"));
    void opPromise.catch(() => {});
    return { kind: "timeout" };
  }

  // The operation settled first — cancel the pending timer and report it.
  sleepCtl.abort();
  return opPromise;
}
