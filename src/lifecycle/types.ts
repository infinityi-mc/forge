/**
 * Core contracts for `forge/lifecycle`.
 *
 * The module is built on one tiny seam — {@link Component} — plus the
 * orchestrator surface ({@link Application}, {@link BootOptions}) and the
 * structurally-typed observability handles. Every Forge object that exposes
 * `start`/`stop`/`healthcheck` (the `db`, an `HttpServer`, a messaging
 * `consumer`) already satisfies {@link Component} structurally, so nothing
 * elsewhere needs to change.
 *
 * @module
 */

/* -------------------------------------------------------------------------- */
/* Component seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Anything the application starts and stops. Every method is optional so
 * existing Forge objects satisfy it structurally with zero changes — a
 * component can contribute just a `healthcheck`, just a `stop`, or all three.
 */
export interface Component {
  /** Human-readable id used in logs, spans, and health output. */
  readonly name: string;
  /** Acquire resources / begin serving. {@link boot} awaits this. */
  start?(ctx: LifecycleContext): Promise<void> | void;
  /** Release resources / drain. Shutdown awaits this (reverse order). */
  stop?(ctx: LifecycleContext): Promise<void> | void;
  /** Report health for readiness/liveness probes. */
  healthcheck?(ctx: HealthContext): Promise<HealthResult> | HealthResult;
}

/**
 * Context handed to a component's `start`/`stop`. The `signal` aborts when the
 * phase exceeds its timeout slice — pass it to cooperating I/O so a hung
 * operation can be cancelled rather than leaked.
 */
export interface LifecycleContext {
  /** Aborted when this phase exceeds its timeout. Pass to cooperating I/O. */
  readonly signal: AbortSignal;
  /** Structural logger bound to this component (child of the app logger). */
  readonly logger: Logger;
}

/**
 * Context handed to a component's `healthcheck`. Carries an `AbortSignal` so a
 * probe that calls a downstream can be bounded, plus the component's logger.
 */
export interface HealthContext {
  /** Aborted when the health check exceeds its budget. */
  readonly signal: AbortSignal;
  /** Structural logger bound to this component. */
  readonly logger: Logger;
}

/* -------------------------------------------------------------------------- */
/* Health result types (the probe implementation arrives in PR B)             */
/* -------------------------------------------------------------------------- */

/** Worst-of health status. `degraded` is distinct from `unhealthy`. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** The result of a single {@link Component.healthcheck}. */
export interface HealthResult {
  readonly status: HealthStatus;
  readonly detail?: string;
  /** Optional structured data (latency, pool stats) — never secrets. */
  readonly data?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator surface                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The running application returned by {@link boot}. Holds the started
 * components, exposes the readiness flag, and lets the caller trigger (or await)
 * a graceful shutdown.
 */
export interface Application {
  /** Started components, in start order. */
  readonly components: readonly Component[];
  /** The app logger (child loggers are derived per component). */
  readonly logger: Logger;
  /** Current readiness — false until all `start()` complete, false on shutdown. */
  readonly ready: boolean;
  /** Trigger graceful shutdown manually (same path as a signal). Idempotent. */
  stop(reason?: string): Promise<void>;
  /** Resolves when the app has fully shut down. */
  readonly done: Promise<void>;
}

/** Options for {@link boot}. */
export interface BootOptions {
  /** Components in dependency order; stopped in strict reverse. */
  readonly components: readonly Component[];
  /** Frozen config (typically from forge/config). Passed through, not parsed. */
  readonly config?: unknown;
  /** Total graceful-shutdown budget in ms. Default 30_000. */
  readonly shutdownTimeout?: number;
  /** Per-component start timeout in ms. Default: `shutdownTimeout`. */
  readonly startTimeout?: number;
  /** Signals that trigger shutdown. Default `["SIGTERM", "SIGINT"]`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Opt-in telemetry handles (structural). Emits nothing when omitted. */
  readonly telemetry?: LifecycleTelemetry;
  /** Opt-in logger (structural). A silent no-op logger is used when omitted. */
  readonly logger?: Logger;
  /** Drain delay before stopping: lets LBs notice unreadiness. Default 0. */
  readonly preStopDelayMs?: number;

  /* ---- Injection seams (primarily for testing) ------------------------- */
  /**
   * Process-exit hook called once shutdown completes. Default `process.exit`.
   * Injected by tests so a run never actually kills the test runner.
   */
  readonly exit?: ExitFn;
  /** Clock used for all timeouts. Default {@link realClock}; tests inject a fake. */
  readonly clock?: Clock;
  /**
   * Whether to install real `process` signal handlers. Default `true`.
   * Tests set this to `false` to avoid leaking global handlers.
   */
  readonly installSignals?: boolean;
}

/** Called with the process exit code once shutdown completes. */
export type ExitFn = (code: number) => void;

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slice of clock behaviour `forge/lifecycle` needs to bound every phase.
 * `realClock` delegates to `Date.now`/`setTimeout`; tests inject a deterministic
 * `TestClock` (`forge/lifecycle/testing`).
 */
export interface Clock {
  /** Current wall-clock millisecond timestamp. */
  now(): number;
  /**
   * Resolve after `ms` milliseconds. Rejects with `signal.reason` if `signal`
   * aborts first, so a pending sleep never outlives the work it bounds.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Structural observability contracts (no hard `forge/telemetry` dependency)  */
/* -------------------------------------------------------------------------- */

/** Attribute bag attached to metrics and spans. */
export type Attributes = Record<string, string | number | boolean>;

/** A counter instrument — structurally compatible with `forge/telemetry`. */
export interface CounterLike {
  add(value: number, attributes?: Attributes): void;
}

/** A histogram instrument — structurally compatible with `forge/telemetry`. */
export interface HistogramLike {
  record(value: number, attributes?: Attributes): void;
}

/** A bi-directional counter — structurally compatible with `forge/telemetry`. */
export interface UpDownCounterLike {
  add(value: number, attributes?: Attributes): void;
}

/** The slice of a meter `forge/lifecycle` uses. */
export interface MeterLike {
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): CounterLike;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): HistogramLike;
  createUpDownCounter?(
    name: string,
    options?: { description?: string; unit?: string },
  ): UpDownCounterLike;
}

/** A span — structurally compatible with `forge/telemetry`. */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
  end(endTime?: Date): void;
}

/** The slice of a tracer `forge/lifecycle` uses. */
export interface TracerLike {
  startSpan(
    name: string,
    options?: {
      kind?: "internal" | "server" | "client" | "producer" | "consumer";
      attributes?: Attributes;
    },
  ): SpanLike;
}

/** Opt-in telemetry handles for boot/shutdown. Structural; no hard import. */
export interface LifecycleTelemetry {
  readonly meter?: MeterLike;
  readonly tracer?: TracerLike;
}

/** Structured-attribute bag accepted by {@link Logger} methods. */
export type LogAttributes = Readonly<Record<string, unknown>>;

/**
 * Minimum logger surface `forge/lifecycle` invokes. Structurally compatible with
 * `forge/telemetry/log` child loggers and `console`, but deliberately not
 * imported from either. The optional `child` lets the orchestrator bind a
 * per-component logger when the handle supports it.
 */
export interface Logger {
  debug(msg: string, attrs?: LogAttributes): void;
  info(msg: string, attrs?: LogAttributes): void;
  warn(msg: string, attrs?: LogAttributes): void;
  error(msg: string, attrs?: LogAttributes): void;
  child?(attributes: LogAttributes): Logger;
}
