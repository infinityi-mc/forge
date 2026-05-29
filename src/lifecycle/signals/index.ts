/**
 * `installSignalHandlers` — the single source of truth for translating OS
 * signals into a graceful-shutdown trigger.
 *
 * `boot()` installs these internally, but the function is exported standalone
 * for apps that orchestrate their own lifecycle. It is idempotent per call,
 * reversible (returns a disposer that removes every listener — important so
 * tests never leak global handlers), and ships the double-signal escape hatch:
 * a first `SIGTERM` begins graceful shutdown, a second identical signal forces
 * an immediate `exit(1)` so an operator can always bail out of a stuck drain.
 *
 * @example
 * ```ts
 * import { installSignalHandlers } from "forge/lifecycle/signals";
 *
 * const dispose = installSignalHandlers({
 *   onSignal: (sig) => app.stop(sig),
 * });
 * // …later, to remove the listeners:
 * dispose();
 * ```
 *
 * @module
 */

import type { SignalHandlerOptions, SignalSource } from "./types";
import type { ExitFn } from "../types";

export type { SignalHandlerOptions, SignalSource } from "./types";

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/**
 * Install handlers for the configured signals and return a disposer that
 * removes them. The disposer is safe to call more than once.
 */
export function installSignalHandlers(
  options: SignalHandlerOptions,
): () => void {
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const forceExitOnSecond = options.forceExitOnSecond ?? true;
  const source: SignalSource = options.source ?? (process as SignalSource);
  const exit: ExitFn = options.exit ?? ((code) => process.exit(code));

  // Tracks signals already seen so a second identical one can force exit.
  const seen = new Set<NodeJS.Signals>();
  const listeners = new Map<
    NodeJS.Signals,
    (signal: NodeJS.Signals) => void
  >();

  for (const signal of signals) {
    const listener = (received: NodeJS.Signals = signal): void => {
      if (seen.has(signal)) {
        if (forceExitOnSecond) {
          exit(1);
        }
        return;
      }
      seen.add(signal);
      void options.onSignal(received);
    };
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      source.off(signal, listener);
    }
    listeners.clear();
  };
}
