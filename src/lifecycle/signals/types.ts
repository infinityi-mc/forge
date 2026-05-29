/**
 * Types for {@link installSignalHandlers}.
 *
 * @module
 */

import type { ExitFn } from "../types";

/**
 * The minimal slice of `process` the signal handlers attach to. `process`
 * satisfies it structurally; tests inject a fake emitter so no real global
 * handlers are touched.
 */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/** Options for {@link installSignalHandlers}. */
export interface SignalHandlerOptions {
  /** Signals to listen for. Default `["SIGTERM", "SIGINT"]`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Invoked once on the first matching signal. */
  readonly onSignal: (signal: NodeJS.Signals) => Promise<void> | void;
  /** A second identical signal forces immediate exit. Default `true`. */
  readonly forceExitOnSecond?: boolean;
  /* ---- Injection seams (primarily for testing) ------------------------- */
  /** Emitter the handlers attach to. Default `process`. */
  readonly source?: SignalSource;
  /** Exit hook for the double-signal escape hatch. Default `process.exit`. */
  readonly exit?: ExitFn;
}
