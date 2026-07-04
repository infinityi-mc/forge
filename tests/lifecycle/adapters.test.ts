import { describe, expect, test } from "bun:test";
import {
  bulkheadComponent,
  configComponent,
  consumerComponent,
  circuitBreakerComponent,
  databaseComponent,
  httpServerComponent,
  messageBusComponent,
  preferenceComponent,
  poolComponent,
  relayComponent,
  securityComponent,
  telemetryComponent,
  workerComponent,
} from "../../src/lifecycle/adapters";
import type { CircuitBreakerState } from "../../src/lifecycle/adapters";
import { boot } from "../../src/lifecycle";
import { TestClock } from "../../src/lifecycle/testing";
import type { HealthContext } from "../../src/lifecycle/types";

const HEALTH_CTX: HealthContext = {
  signal: new AbortController().signal,
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  },
};

describe("telemetryComponent", () => {
  test("stops telemetry by calling shutdown exactly once and has no start hook", async () => {
    const calls: string[] = [];
    const c = telemetryComponent("telemetry", {
      shutdown: () => {
        calls.push("shutdown");
      },
    });

    expect(c.start).toBeUndefined();

    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });

    expect(calls).toEqual(["shutdown"]);
  });

  test("no healthcheck is derived by default", () => {
    const c = telemetryComponent("telemetry", { shutdown: () => {} });
    expect(c.healthcheck).toBeUndefined();
  });

  test("a custom healthcheck overrides the absent derived one", async () => {
    const c = telemetryComponent("telemetry", { shutdown: () => {} }, {
      healthcheck: () => ({ status: "degraded", detail: "exporter lag" }),
    });

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "exporter lag",
    });
  });
});

describe("configComponent", () => {
  test("stops dynamic config by calling shutdown exactly once and has no start hook", async () => {
    const calls: string[] = [];
    const c = configComponent("config", {
      shutdown: () => {
        calls.push("shutdown");
      },
    });

    expect(c.start).toBeUndefined();

    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });

    expect(calls).toEqual(["shutdown"]);
  });

  test("no healthcheck is derived by default", () => {
    const c = configComponent("config", { shutdown: () => {} });
    expect(c.healthcheck).toBeUndefined();
  });

  test("a custom healthcheck overrides the absent derived one", async () => {
    const c = configComponent("config", { shutdown: () => {} }, {
      healthcheck: () => ({ status: "degraded", detail: "provider lag" }),
    });

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "provider lag",
    });
  });
});

describe("preferenceComponent", () => {
  test("stops preferences by calling shutdown exactly once and has no start hook", async () => {
    const calls: string[] = [];
    const c = preferenceComponent("preferences", {
      shutdown: () => {
        calls.push("shutdown");
      },
    });

    expect(c.start).toBeUndefined();

    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });

    expect(calls).toEqual(["shutdown"]);
  });

  test("no healthcheck is derived by default", () => {
    const c = preferenceComponent("preferences", { shutdown: () => {} });
    expect(c.healthcheck).toBeUndefined();
  });

  test("a custom healthcheck overrides the absent derived one", async () => {
    const c = preferenceComponent("preferences", { shutdown: () => {} }, {
      healthcheck: () => ({ status: "degraded", detail: "store lag" }),
    });

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "store lag",
    });
  });
});

describe("securityComponent", () => {
  test("derives healthcheck from security health", async () => {
    const c = securityComponent("security", {
      health: () => ({ status: "healthy", checkedAt: new Date(0) }),
    });

    expect(c.start).toBeUndefined();
    expect(c.stop).toBeUndefined();
    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      data: { checkedAt: new Date(0).toISOString() },
    });
  });

  test("maps unhealthy health results to detail and can downgrade to degraded", async () => {
    const c = securityComponent("security", {
      health: () => ({
        status: "unhealthy",
        message: "JWKS fetch failed",
        checkedAt: new Date(0),
      }),
    }, { degraded: true });

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "JWKS fetch failed",
      data: { checkedAt: new Date(0).toISOString() },
    });
  });

  test("stops security resources when shutdown is available", async () => {
    const calls: string[] = [];
    const c = securityComponent("security", {
      health: () => ({ status: "healthy" }),
      shutdown: () => {
        calls.push("shutdown");
      },
    });

    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });

    expect(calls).toEqual(["shutdown"]);
  });

  test("a custom healthcheck overrides derived security health", async () => {
    const c = securityComponent("security", {
      health: () => ({ status: "healthy" }),
    }, {
      healthcheck: () => ({ status: "degraded", detail: "idp lag" }),
    });

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "idp lag",
    });
  });
});

describe("databaseComponent", () => {
  test("pings on start, shuts down on stop, and derives a healthcheck", async () => {
    const calls: string[] = [];
    const db = {
      ping: () => {
        calls.push("ping");
      },
      shutdown: () => {
        calls.push("shutdown");
      },
    };
    const c = databaseComponent("db", db);
    await c.start?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(calls).toEqual(["ping", "shutdown"]);

    const health = await c.healthcheck?.(HEALTH_CTX);
    expect(health).toEqual({ status: "healthy", data: { ping: "ok" } });
  });

  test("a failing ping is reported unhealthy, not thrown", async () => {
    const db = {
      ping: () => {
        throw new Error("unreachable");
      },
      shutdown: () => {},
    };
    const c = databaseComponent("db", db);
    const health = await c.healthcheck?.(HEALTH_CTX);
    expect(health?.status).toBe("unhealthy");
    expect(health?.detail).toContain("unreachable");
  });

  test("pingOnStart: false omits the start hook", () => {
    const db = { ping: () => {}, shutdown: () => {} };
    const c = databaseComponent("db", db, { pingOnStart: false });
    expect(c.start).toBeUndefined();
    expect(c.stop).toBeDefined();
  });

  test("a custom healthcheck overrides the derived one", async () => {
    const db = { ping: () => {}, shutdown: () => {} };
    const c = databaseComponent("db", db, {
      healthcheck: () => ({ status: "degraded", detail: "read replica lag" }),
    });
    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "read replica lag",
    });
  });
});

describe("poolComponent", () => {
  test("stop prefers shutdown() and falls back to drain()", async () => {
    const withShutdown: string[] = [];
    const c1 = poolComponent("pool", {
      drain: () => {
        withShutdown.push("drain");
      },
      shutdown: () => {
        withShutdown.push("shutdown");
      },
    });
    await c1.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(withShutdown).toEqual(["shutdown"]);

    const drainOnly: string[] = [];
    const c2 = poolComponent("pool", {
      drain: () => {
        drainOnly.push("drain");
      },
    });
    await c2.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(drainOnly).toEqual(["drain"]);
  });

  test("healthcheck reflects stats(): draining is unhealthy", async () => {
    const c = poolComponent("pool", {
      drain: () => {},
      stats: () => ({ draining: true, active: 0, idle: 0, waiting: 0 }),
    });
    expect((await c.healthcheck?.(HEALTH_CTX))?.status).toBe("unhealthy");

    const healthy = poolComponent("pool", {
      drain: () => {},
      stats: () => ({ draining: false, active: 1, idle: 2, waiting: 0 }),
    });
    expect(await healthy.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      data: { active: 1, idle: 2, waiting: 0 },
    });
  });

  test("no stats() and no override means no healthcheck seam", () => {
    const c = poolComponent("pool", { drain: () => {} });
    expect(c.healthcheck).toBeUndefined();
  });
});

describe("httpServerComponent", () => {
  test("stop drains in-flight requests via stop(true) by default", async () => {
    const args: boolean[] = [];
    const c = httpServerComponent("http", {
      stop: (close) => {
        args.push(close ?? false);
      },
    });
    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(args).toEqual([true]);
    expect(c.start).toBeUndefined();
  });

  test("closeActiveConnections is configurable", async () => {
    const args: boolean[] = [];
    const c = httpServerComponent(
      "http",
      {
        stop: (close) => {
          args.push(close ?? false);
        },
      },
      { closeActiveConnections: false },
    );
    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(args).toEqual([false]);
  });
});

describe("messaging adapters", () => {
  test("messageBusComponent flushes then shuts down", async () => {
    const calls: string[] = [];
    const c = messageBusComponent("bus", {
      flush: async () => {
        calls.push("flush");
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
    });
    await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
    expect(calls).toEqual(["flush", "shutdown"]);
  });

  test("consumer/relay/worker map start and stop", async () => {
    for (const make of [consumerComponent, relayComponent, workerComponent]) {
      const calls: string[] = [];
      const c = make("runner", {
        start: () => {
          calls.push("start");
        },
        stop: () => {
          calls.push("stop");
        },
      });
      await c.start?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
      await c.stop?.({ signal: new AbortController().signal, logger: HEALTH_CTX.logger });
      expect(calls).toEqual(["start", "stop"]);
    }
  });
});

describe("resilience adapters", () => {
  test("circuitBreakerComponent maps closed, half-open, and open states", async () => {
    let state: CircuitBreakerState = "closed";
    const breaker = {
      get state() {
        return state;
      },
    };
    const c = circuitBreakerComponent("upstream-breaker", breaker);

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      data: { state: "closed" },
    });

    state = "half-open";
    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "circuit breaker is half-open",
      data: { state: "half-open" },
    });

    state = "open";
    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "unhealthy",
      detail: "circuit breaker is open",
      data: { state: "open" },
    });
  });

  test("circuitBreakerComponent can report open breakers as degraded", async () => {
    const c = circuitBreakerComponent(
      "upstream-breaker",
      { state: "open" },
      { degraded: true },
    );

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      detail: "circuit breaker is open",
      data: { state: "open" },
    });
  });

  test("bulkheadComponent reports queued callers as degraded by default", async () => {
    const healthy = bulkheadComponent("upstream-bulkhead", {
      active: 2,
      queued: 0,
    });
    expect(await healthy.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      data: { active: 2, queued: 0 },
    });

    const saturated = bulkheadComponent("upstream-bulkhead", {
      active: 10,
      queued: 1,
    });
    expect(await saturated.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "degraded",
      data: { active: 10, queued: 1 },
    });
  });

  test("bulkheadComponent can report saturation as unhealthy", async () => {
    const c = bulkheadComponent(
      "upstream-bulkhead",
      { active: 10, queued: 2 },
      { unhealthyAtSaturation: true },
    );

    expect(await c.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "unhealthy",
      data: { active: 10, queued: 2 },
    });
  });

  test("custom resilience adapter healthchecks override derived readiness", async () => {
    const breaker = circuitBreakerComponent("upstream-breaker", { state: "open" }, {
      healthcheck: () => ({ status: "healthy", detail: "maintenance override" }),
    });
    const bulkhead = bulkheadComponent("upstream-bulkhead", { active: 10, queued: 3 }, {
      healthcheck: () => ({ status: "healthy", detail: "queue ignored" }),
    });

    expect(await breaker.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      detail: "maintenance override",
    });
    expect(await bulkhead.healthcheck?.(HEALTH_CTX)).toEqual({
      status: "healthy",
      detail: "queue ignored",
    });
  });
});

describe("adapters integrate with boot — strict reverse stop order", () => {
  test("messaging stops before the database it depends on", async () => {
    const events: string[] = [];
    const db = {
      ping: () => {
        events.push("db:ping");
      },
      shutdown: () => {
        events.push("db:shutdown");
      },
    };
    const consumer = {
      start: () => {
        events.push("consumer:start");
      },
      stop: () => {
        events.push("consumer:stop");
      },
    };
    const clock = new TestClock();
    const app = await boot({
      components: [databaseComponent("db", db), consumerComponent("consumer", consumer)],
      clock,
      installSignals: false,
      exit: () => {},
    });
    expect(events).toEqual(["db:ping", "consumer:start"]);

    await app.stop();
    expect(events).toEqual([
      "db:ping",
      "consumer:start",
      "consumer:stop",
      "db:shutdown",
    ]);
  });
});
