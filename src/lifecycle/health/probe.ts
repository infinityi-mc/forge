/**
 * `createProbe` — the readiness/liveness aggregator.
 *
 * Folds every registered {@link HealthCheck} into an {@link AggregateHealth}
 * worst-of (`healthy` < `degraded` < `unhealthy`), honouring per-check
 * `critical` flags so a non-critical outage degrades rather than fails
 * readiness. Liveness is kept deliberately cheap and independent of downstream
 * checks (spec §5).
 *
 * @module
 */

import { realClock } from "../clock";
import { createLifecycleMetrics, now } from "../observability";
import { silentLogger } from "../phase";
import type {
  Clock,
  HealthContext,
  HealthResult,
  HealthStatus,
  LifecycleTelemetry,
  Logger,
} from "../types";
import type {
  AggregateHealth,
  HealthCheck,
  Probe,
  ProbeOptions,
} from "./types";

const DEFAULT_CHECK_TIMEOUT = 5_000;

const STATUS_RANK: Readonly<Record<HealthStatus, number>> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

/** Return the worse of two statuses (`unhealthy` > `degraded` > `healthy`). */
function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A bounded check's result plus how long it took. */
interface TimedResult {
  readonly result: HealthResult;
  readonly durationMs: number;
}

/**
 * Build a {@link Probe} over a set of named checks plus readiness/liveness
 * gates. The probe holds no global state beyond its creation timestamp; create
 * as many as you like.
 */
export function createProbe(options: ProbeOptions = {}): Probe {
  const checks: readonly HealthCheck[] = options.checks ?? [];
  const readyGate = options.ready ?? (() => true);
  const liveGate = options.live ?? (() => true);
  const clock: Clock = options.clock ?? realClock;
  const checkTimeout = options.checkTimeout ?? DEFAULT_CHECK_TIMEOUT;
  const logger: Logger = options.logger ?? silentLogger;
  const metrics = createLifecycleMetrics(options.telemetry);

  const startedAt = clock.now();
  const uptimeMs = (): number => Math.max(0, clock.now() - startedAt);

  async function check(): Promise<AggregateHealth> {
    // Gate closed (startup/shutdown): not-ready without touching downstreams.
    if (!readyGate()) {
      return {
        status: "unhealthy",
        checks: {},
        ready: false,
        uptimeMs: uptimeMs(),
      };
    }

    const results: Record<string, HealthResult> = {};
    let status: HealthStatus = "healthy";
    let criticalUnhealthy = false;

    for (const c of checks) {
      const { result, durationMs } = await runCheck(
        c,
        clock,
        checkTimeout,
        logger,
      );
      results[c.name] = result;
      metrics.healthCheckDuration.record(durationMs, {
        check: c.name,
        status: result.status,
      });

      const critical = c.critical ?? true;
      if (result.status === "unhealthy") {
        // A non-critical failure only degrades; a critical one fails readiness.
        status = worst(status, critical ? "unhealthy" : "degraded");
        if (critical) criticalUnhealthy = true;
      } else {
        status = worst(status, result.status);
      }
    }

    return {
      status,
      checks: results,
      ready: !criticalUnhealthy,
      uptimeMs: uptimeMs(),
    };
  }

  function liveness(): AggregateHealth {
    const alive = liveGate();
    return {
      status: alive ? "healthy" : "unhealthy",
      checks: {},
      ready: alive,
      uptimeMs: uptimeMs(),
    };
  }

  return { check, liveness };
}

/**
 * Run a single check bounded by `timeoutMs`. A throw or an overrun is reported
 * as `unhealthy` (never propagated). Returns the result and its elapsed time.
 */
async function runCheck(
  check: HealthCheck,
  clock: Clock,
  timeoutMs: number,
  logger: Logger,
): Promise<TimedResult> {
  const controller = new AbortController();
  const ctx: HealthContext = { signal: controller.signal, logger };
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;

  const opPromise: Promise<HealthResult> = (async () => {
    try {
      return await check.check(ctx);
    } catch (error) {
      return {
        status: "unhealthy",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { result: await opPromise, durationMs: elapsed() };
  }

  const sleepCtl = new AbortController();
  const TIMED_OUT = Symbol("timed-out");
  const timeoutPromise: Promise<typeof TIMED_OUT | null> = clock
    .sleep(timeoutMs, sleepCtl.signal)
    .then(
      () => TIMED_OUT,
      (): null => null,
    );

  const winner = await Promise.race([opPromise, timeoutPromise]);
  if (winner === TIMED_OUT) {
    controller.abort(new Error("healthcheck timed out"));
    void opPromise.catch(() => {});
    return {
      result: {
        status: "unhealthy",
        detail: `healthcheck exceeded its ${timeoutMs}ms budget`,
      },
      durationMs: elapsed(),
    };
  }
  sleepCtl.abort();
  return { result: await opPromise, durationMs: elapsed() };
}
