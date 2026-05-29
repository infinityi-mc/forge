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
import { componentLogger, runPhase, silentLogger } from "./phase";
import { stopComponents } from "./shutdown";
import { installSignalHandlers } from "./signals";
import type {
  Application,
  BootOptions,
  Clock,
  Component,
  ExitFn,
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

  const started: Component[] = [];
  let ready = false;
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

  function triggerShutdown(reason?: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    ready = false;
    logger.info("lifecycle.shutdown.start", reason ? { reason } : undefined);
    const startedAt = clock.now();
    shutdownPromise = (async () => {
      if (preStopDelayMs > 0) {
        await clock.sleep(preStopDelayMs);
      }
      const result = await stopComponents(started, {
        logger,
        clock,
        shutdownTimeout,
      });
      const failed = result.errors.length > 0 || result.timeouts.length > 0;
      logger.info("lifecycle.shutdown.done", {
        durationMs: clock.now() - startedAt,
        errors: result.errors.length,
        timeouts: result.timeouts.length,
      });
      resolveDone();
      disposeSignals();
      exit(failed ? 1 : 0);
    })();
    return shutdownPromise;
  }

  // ---- Ordered start with rollback on failure ----------------------------
  const bootStartedAt = clock.now();
  for (const component of components) {
    const log = componentLogger(logger, component.name);
    if (typeof component.start === "function") {
      log.debug("lifecycle.component.start.start", { component: component.name });
      const outcome = await runPhase(
        (ctx) => component.start!(ctx),
        log,
        startTimeout,
        clock,
      );
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
        await stopComponents(started, { logger, clock, shutdownTimeout });
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

  ready = true;
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
