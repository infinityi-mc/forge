import { describe, expect, test } from "bun:test";
import { PoolError } from "../../src/data";
import { createPool } from "../../src/data/pool";

describe("data pool", () => {
  test("acquires, releases, and reuses resources", async () => {
    let created = 0;
    const pool = createPool({
      max: 1,
      create: () => ({ id: ++created }),
    });

    const first = await pool.acquire();
    expect(first.resource.id).toBe(1);
    expect(pool.stats().active).toBe(1);
    first.release();
    expect(pool.stats().idle).toBe(1);

    const second = await pool.acquire();
    expect(second.resource.id).toBe(1);
    second.release();
  });

  test("queues waiters until a resource is released", async () => {
    const pool = createPool({
      max: 1,
      create: () => ({ id: 1 }),
    });

    const first = await pool.acquire();
    const secondPromise = pool.acquire();
    expect(pool.stats().waiting).toBe(1);

    first.release();
    const second = await secondPromise;
    expect(second.resource.id).toBe(1);
    second.release();
  });

  test("times out waiters", async () => {
    const pool = createPool({
      max: 1,
      acquireTimeoutMs: 1,
      create: () => ({ id: 1 }),
    });

    const first = await pool.acquire();
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolError);
    first.release();
  });

  test("drain rejects new work and waits for active releases", async () => {
    let closed = 0;
    const pool = createPool({
      max: 1,
      create: () => ({ shutdown: () => { closed += 1; } }),
    });

    const lease = await pool.acquire();
    const drained = pool.drain();
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolError);
    expect(closed).toBe(0);
    lease.release();
    await drained;
    expect(closed).toBe(1);
  });

  test("drain waits for async shutdown when active resources release during drain", async () => {
    let resolveShutdown!: () => void;
    let closed = false;
    const pool = createPool({
      max: 1,
      create: () => ({
        shutdown: async () => {
          await new Promise<void>((resolve) => {
            resolveShutdown = resolve;
          });
          closed = true;
        },
      }),
    });

    const lease = await pool.acquire();
    const drained = pool.drain();
    let drainResolved = false;
    void drained.then(() => {
      drainResolved = true;
    });

    lease.release();
    for (let index = 0; index < 5 && resolveShutdown === undefined; index += 1) {
      await Promise.resolve();
    }
    expect(drainResolved).toBe(false);

    resolveShutdown();
    await drained;
    expect(closed).toBe(true);
  });

  test("drain waits for in-flight acquire creation and rejects the acquire", async () => {
    let resolveCreate!: (resource: { shutdown: () => Promise<void> }) => void;
    let resolveShutdown!: () => void;
    let closed = false;
    const pool = createPool({
      max: 1,
      create: () => new Promise<{ shutdown: () => Promise<void> }>((resolve) => {
        resolveCreate = resolve;
      }),
    });

    const acquire = pool.acquire();
    const drained = pool.drain();
    let drainResolved = false;
    void drained.then(() => {
      drainResolved = true;
    });

    await Promise.resolve();
    expect(drainResolved).toBe(false);

    resolveCreate({
      shutdown: async () => {
        await new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
        closed = true;
      },
    });
    for (let index = 0; index < 5 && resolveShutdown === undefined; index += 1) {
      await Promise.resolve();
    }

    expect(drainResolved).toBe(false);
    resolveShutdown();
    await expect(acquire).rejects.toBeInstanceOf(PoolError);
    await drained;
    expect(closed).toBe(true);
  });

  test("drain rejects when async resource shutdown fails", async () => {
    const pool = createPool({
      max: 1,
      create: () => ({
        shutdown: async () => {
          throw new Error("close failed");
        },
      }),
    });

    const lease = await pool.acquire();
    const drained = pool.drain();
    lease.release();

    await expect(drained).rejects.toBeInstanceOf(AggregateError);
  });

  test("pre-warmed resources resolve queued waiters instead of idling", async () => {
    let resolveCreate!: (resource: { id: number }) => void;
    const pool = createPool({
      min: 1,
      max: 1,
      acquireTimeoutMs: 50,
      create: () => new Promise<{ id: number }>((resolve) => {
        resolveCreate = resolve;
      }),
    });

    const leasePromise = pool.acquire();
    expect(pool.stats().waiting).toBe(1);

    resolveCreate({ id: 1 });
    const lease = await leasePromise;
    expect(lease.resource.id).toBe(1);
    expect(pool.stats().active).toBe(1);
    expect(pool.stats().idle).toBe(0);
    lease.release();
  });

  test("shutdown waits for in-flight pre-warm resources to close", async () => {
    let resolveCreate!: (resource: { shutdown: () => Promise<void> }) => void;
    let closed = false;
    let resolveShutdown!: () => void;
    const pool = createPool({
      min: 1,
      max: 1,
      create: () => new Promise<{ shutdown: () => Promise<void> }>((resolve) => {
        resolveCreate = resolve;
      }),
    });

    const shutdown = pool.shutdown();
    let shutdownResolved = false;
    void shutdown.then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    resolveCreate({
      shutdown: async () => {
        await new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
        closed = true;
      },
    });
    for (let index = 0; index < 5 && resolveShutdown === undefined; index += 1) {
      await Promise.resolve();
    }
    expect(shutdownResolved).toBe(false);

    resolveShutdown();
    await shutdown;
    expect(closed).toBe(true);
  });
});
