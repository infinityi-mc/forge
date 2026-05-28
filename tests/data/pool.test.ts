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
});
