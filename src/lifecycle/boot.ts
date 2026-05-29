/**
 * `forge.boot()` — the orchestrator.
 *
 * Boot validates the component set, installs signal handlers, then starts
 * components in array order under a per-component start timeout. If any
 * `start()` rejects or overruns, boot rolls back (stops the already-started
 * components in reverse) and rejects with a {@link StartupError} — the app
 * never reaches `ready`. Once every `start()` resolves, `ready` flips true and
 * an {@link Application} is returned whose `stop()`/`done` drive the bounded,
 * reverse-order graceful shutdown.
 *
 * @module
 */

import { realClock } from "./clock";
import {
  ComponentRegistrationError,
  StartupError,
} from "./errors";
import { createProbe, startHealthServer } from "./health";
import { createLifecycleMetrics, now, withSpan } from "./observability";
import { componentLogger, runPhase, silentLogger } from "./phase";
import { stopComponents } from "./shutdown";
import { installSignalHandlers } from "./signals";
import type {
  Application,
  BootOptions,
  Clock,
  Component,
  ExitFn,
  HealthContext,
  Logger,
} from "./types";

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

/**
 * Boot an application from its components. See the module docs for the full
 * start/rollback/shutdown contract.
 *
 * @throws {ComponentRegistrationError} if a component has a blank or duplicate name.
 * @throws {StartupError} if a component's `start()` fails (after rollback).
 */
export async function boot(options: BootOptions): Promise<Application> {
  const components = options.components;
  validateComponents(components);

  const logger: Logger = options.logger ?? silentLogger;
  const clock: Clock = options.clock ?? realClock;
  const exit: ExitFn = options.exit ?? ((code) => process.exit(code));
  const shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
  const startTimeout = options.startTimeout ?? shutdownTimeout;
  const preStopDelayMs = options.preStopDelayMs ?? 0;
  const installSignals = options.installSignals ?? true;
  const metrics = createLifecycleMetrics(options.telemetry);
  const tracer = options.telemetry?.tracer;

  const started: Component[] = [];
  let ready = false;
  let readyEmitted = false;
  let shutdownPromise: Promise<void> | undefined;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // Install signal handlers up front so a signal during startup still triggers
  // an orderly rollback-then-shutdown rather than being dropped.
  const disposeSignals = installSignals
    ? installSignalHandlers({
        signals: options.signals,
        onSignal: (signal) => triggerShutdown(signal),
        exit,
      })
    : () => {};

  // Optional standalone health server, started before components so `/readyz`
  // returns 503 throughout startup and torn down at the end of shutdown.
  let disposeHealth: () => void;
  try {
    disposeHealth = startHealthIfRequested();
  } catch (err) {
    disposeSignals();
    throw err;
  }

  function startHealthIfRequested(): () => void {
    if (options.health === undefined) return () => {};
    const checks = components
      .filter(
        (c): c is Component & { healthcheck: NonNullable<Component["healthcheck"]> } =>
          typeof c.healthcheck === "function",
      )
      .map((c) => ({
        name: c.name,
        check: (ctx: HealthContext) => c.healthcheck(ctx),
      }));
    const probe = createProbe({
      checks,
      ready: () => ready,
      clock,
      logger,
      ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
    });
    const server = startHealthServer(probe, options.health);
    logger.info("lifecycle.health.server.start", {
      port: server.port,
      url: server.url,
    });
    return () => server.stop();
  }

  function triggerShutdown(reason?: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    ready = false;
    if (readyEmitted) {
      metrics.ready.add(-1);
      readyEmitted = false;
    }
    logger.info("lifecycle.shutdown.start", reason ? { reason } : undefined);
    const startedAt = clock.now();
    const perfStartedAt = now();
    shutdownPromise = withSpan(
      tracer,
      "lifecycle.shutdown",
      { kind: "internal", ...(reason ? { attributes: { reason } } : {}) },
      async () => {
        if (preStopDelayMs > 0) {
          await clock.sleep(preStopDelayMs);
        }
        const result = await stopComponents(started, {
          logger,
          clock,
          shutdownTimeout,
          metrics,
          ...(tracer !== undefined ? { tracer } : {}),
        });
        const failed = result.errors.length > 0 || result.timeouts.length > 0;
        metrics.shutdownDuration.record(now() - perfStartedAt);
        logger.info("lifecycle.shutdown.done", {
          durationMs: clock.now() - startedAt,
          errors: result.errors.length,
          timeouts: result.timeouts.length,
        });
        resolveDone();
        disposeHealth();
        disposeSignals();
        exit(failed ? 1 : 0);
      },
    );
    return shutdownPromise;
  }

  // ---- Ordered start with rollback on failure ----------------------------
  const bootStartedAt = clock.now();
  const bootPerfStartedAt = now();
  await withSpan(tracer, "lifecycle.boot", { kind: "internal" }, async () => {
    for (const component of components) {
      const log = componentLogger(logger, component.name);
      if (typeof component.start === "function") {
        log.debug("lifecycle.component.start.start", { component: component.name });
        const startPerfAt = now();
        const outcome = await withSpan(
          tracer,
          "lifecycle.component.start",
          { kind: "internal", attributes: { component: component.name } },
          () => runPhase((ctx) => component.start!(ctx), log, startTimeout, clock),
        );
        metrics.startDuration.record(now() - startPerfAt, {
          component: component.name,
          outcome:
            outcome.kind === "ok"
              ? "ok"
              : outcome.kind === "timeout"
                ? "timeout"
                : "error",
        });
        if (outcome.kind !== "ok") {
          const cause =
            outcome.kind === "error"
              ? outcome.error
              : new Error(`start() exceeded its ${startTimeout}ms timeout`);
          log.error("lifecycle.component.start.error", {
            component: component.name,
            error: String(cause),
          });
          // Roll back the components that did start, in reverse, then bail.
          await stopComponents(started, {
            logger,
            clock,
            shutdownTimeout,
            metrics,
            ...(tracer !== undefined ? { tracer } : {}),
          });
          disposeHealth();
          disposeSignals();
          throw new StartupError(
            `component "${component.name}" failed to start; boot aborted and rolled back`,
            { component: component.name, cause },
          );
        }
        log.debug("lifecycle.component.start.done", { component: component.name });
      }
      started.push(component);
    }
  });

  ready = true;
  metrics.ready.add(1);
  readyEmitted = true;
  metrics.bootDuration.record(now() - bootPerfStartedAt);
  logger.info("lifecycle.boot.done", {
    durationMs: clock.now() - bootStartedAt,
    components: started.length,
  });

  const application: Application = {
    components: started,
    logger,
    get ready() {
      return ready;
    },
    stop(reason?: string) {
      return triggerShutdown(reason ?? "stop()");
    },
    done,
  };
  return application;
}

/** Validate that every component has a non-empty, unique name. */
function validateComponents(components: readonly Component[]): void {
  const seen = new Set<string>();
  for (const component of components) {
    if (
      !component ||
      typeof component.name !== "string" ||
      component.name.trim() === ""
    ) {
      throw new ComponentRegistrationError(
        "every component must have a non-empty `name`",
      );
    }
    if (seen.has(component.name)) {
      throw new ComponentRegistrationError(
        `duplicate component name "${component.name}"`,
      );
    }
    seen.add(component.name);
  }
}
