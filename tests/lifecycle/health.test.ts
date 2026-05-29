import { afterEach, describe, expect, test } from "bun:test";
import {
  createProbe,
  healthRoutes,
  startHealthServer,
} from "../../src/lifecycle/health";
import type { HealthServer } from "../../src/lifecycle/health";
import { TestClock } from "../../src/lifecycle/testing";

describe("createProbe — readiness aggregation", () => {
  test("worst-of folds healthy/degraded/unhealthy and stays ready when no critical failure", async () => {
    const probe = createProbe({
      checks: [
        { name: "a", check: () => ({ status: "healthy" }) },
        { name: "b", critical: false, check: () => ({ status: "degraded" }) },
      ],
    });
    const health = await probe.check();
    expect(health.status).toBe("degraded");
    expect(health.ready).toBe(true);
    expect(Object.keys(health.checks)).toEqual(["a", "b"]);
  });

  test("a critical unhealthy check makes the aggregate not-ready and unhealthy", async () => {
    const probe = createProbe({
      checks: [
        { name: "a", check: () => ({ status: "healthy" }) },
        { name: "db", critical: true, check: () => ({ status: "unhealthy" }) },
      ],
    });
    const health = await probe.check();
    expect(health.status).toBe("unhealthy");
    expect(health.ready).toBe(false);
  });

  test("a non-critical unhealthy check only degrades and stays ready", async () => {
    const probe = createProbe({
      checks: [{ name: "cache", critical: false, check: () => ({ status: "unhealthy" }) }],
    });
    const health = await probe.check();
    expect(health.status).toBe("degraded");
    expect(health.ready).toBe(true);
  });

  test("a closed ready-gate short-circuits to not-ready without running checks", async () => {
    let called = 0;
    const probe = createProbe({
      ready: () => false,
      checks: [
        {
          name: "db",
          check: () => {
            called++;
            return { status: "healthy" };
          },
        },
      ],
    });
    const health = await probe.check();
    expect(health.ready).toBe(false);
    expect(called).toBe(0);
    expect(health.checks).toEqual({});
  });

  test("a thrown healthcheck is reported as unhealthy, not propagated", async () => {
    const probe = createProbe({
      checks: [
        {
          name: "db",
          check: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const health = await probe.check();
    expect(health.status).toBe("unhealthy");
    expect(health.ready).toBe(false);
    expect(health.checks.db?.detail).toContain("boom");
  });

  test("a check that overruns its budget is abandoned as unhealthy", async () => {
    const clock = new TestClock();
    const probe = createProbe({
      clock,
      checkTimeout: 100,
      checks: [
        {
          name: "slow",
          check: (ctx) => clock.sleep(10_000, ctx.signal).then(() => ({ status: "healthy" as const })),
        },
      ],
    });
    const pending = probe.check();
    await clock.tickAsync(100);
    const health = await pending;
    expect(health.status).toBe("unhealthy");
    expect(health.checks.slow?.detail).toContain("budget");
  });

  test("uptimeMs reflects the injected clock", async () => {
    const clock = new TestClock();
    const probe = createProbe({ clock });
    await clock.tickAsync(1_500);
    const health = await probe.check();
    expect(health.uptimeMs).toBe(1_500);
  });
});

describe("createProbe — liveness independence", () => {
  test("liveness ignores downstream checks and reflects only the live gate", () => {
    let called = 0;
    const probe = createProbe({
      checks: [
        {
          name: "db",
          check: () => {
            called++;
            return { status: "unhealthy" };
          },
        },
      ],
    });
    expect(probe.liveness().status).toBe("healthy");
    expect(called).toBe(0);

    const wedged = createProbe({ live: () => false });
    const dead = wedged.liveness();
    expect(dead.status).toBe("unhealthy");
    expect(dead.ready).toBe(false);
  });
});

describe("healthRoutes — k8s-shaped responses", () => {
  test("returns 200/503 for readiness and 200/503 for liveness, undefined otherwise", async () => {
    let ready = true;
    let alive = true;
    const probe = createProbe({
      ready: () => ready,
      live: () => alive,
      checks: [{ name: "db", check: () => ({ status: "healthy" }) }],
    });
    const routes = healthRoutes(probe);

    const readyz = await routes.handle(new Request("http://x/readyz"));
    expect(readyz?.status).toBe(200);
    expect(await readyz?.json()).toMatchObject({ ready: true, status: "healthy" });

    const livez = await routes.handle(new Request("http://x/livez"));
    expect(livez?.status).toBe(200);

    ready = false;
    alive = false;
    expect((await routes.handle(new Request("http://x/readyz")))?.status).toBe(503);
    expect((await routes.handle(new Request("http://x/livez")))?.status).toBe(503);

    expect(await routes.handle(new Request("http://x/other"))).toBeUndefined();
  });

  test("custom paths are honoured", async () => {
    const probe = createProbe();
    const routes = healthRoutes(probe, {
      livenessPath: "/alive",
      readinessPath: "/ready",
    });
    expect(routes.livenessPath).toBe("/alive");
    expect((await routes.handle(new Request("http://x/alive")))?.status).toBe(200);
    expect(await routes.handle(new Request("http://x/livez"))).toBeUndefined();
  });
});

describe("startHealthServer — standalone Bun.serve", () => {
  let server: HealthServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  test("serves /livez and /readyz on its own port and 404s elsewhere", async () => {
    let ready = true;
    const probe = createProbe({ ready: () => ready });
    server = startHealthServer(probe, { port: 0 });

    const live = await fetch(`${server.url}livez`);
    expect(live.status).toBe(200);

    const readyz = await fetch(`${server.url}readyz`);
    expect(readyz.status).toBe(200);

    ready = false;
    expect((await fetch(`${server.url}readyz`)).status).toBe(503);

    expect((await fetch(`${server.url}nope`)).status).toBe(404);
  });

  test("stop() is idempotent", () => {
    server = startHealthServer(createProbe(), { port: 0 });
    expect(() => {
      server!.stop();
      server!.stop();
    }).not.toThrow();
  });
});
