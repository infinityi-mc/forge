import { PoolError } from "../errors";
import type { Pool, PoolLease, PoolOptions, PoolResource, PoolStats } from "./types";

interface Waiter<Resource extends PoolResource> {
  readonly createdAt: number;
  readonly resolve: (lease: PoolLease<Resource>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

export function createPool<Resource extends PoolResource>(
  options: PoolOptions<Resource>,
): Pool<Resource> {
  if (!Number.isInteger(options.max) || options.max < 1) {
    throw new PoolError("Pool max must be a positive integer");
  }
  const min = options.min ?? 0;
  if (!Number.isInteger(min) || min < 0 || min > options.max) {
    throw new PoolError("Pool min must be an integer between 0 and max");
  }

  const state = {
    active: new Set<Resource>(),
    idle: [] as Resource[],
    waiters: [] as Waiter<Resource>[],
    total: 0,
    draining: false,
    starting: [] as Array<Promise<void>>,
    closing: [] as Array<Promise<void>>,
    closeErrors: [] as unknown[],
    drainResolvers: [] as Array<{ resolve: () => void; reject: (error: unknown) => void }>,
  };

  const waitHistogram = options.telemetry?.meter?.createHistogram(
    "forge_db_pool_wait_time_seconds",
    { description: "Time spent waiting to acquire a database connection.", unit: "s" },
  );
  const activeGauge = options.telemetry?.meter?.createGauge?.(
    "forge_db_pool_active_connections",
    { description: "Connections currently in use." },
  );
  const idleGauge = options.telemetry?.meter?.createGauge?.(
    "forge_db_pool_idle_connections",
    { description: "Connections available in the pool." },
  );

  function recordPoolGauges(): void {
    activeGauge?.record(state.active.size, { pool: options.name ?? "data-pool" });
    idleGauge?.record(state.idle.length, { pool: options.name ?? "data-pool" });
  }

  async function createResource(): Promise<Resource> {
    state.total += 1;
    try {
      return await options.create();
    } catch (cause) {
      state.total -= 1;
      throw new PoolError("Failed to create pool resource", { cause });
    }
  }

  function makeLease(resource: Resource): PoolLease<Resource> {
    let released = false;
    return {
      resource,
      release() {
        if (released) return;
        released = true;
        releaseResource(resource);
      },
    };
  }

  function resolveWaiter(resource: Resource): boolean {
    const waiter = state.waiters.shift();
    if (waiter === undefined) return false;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    state.active.add(resource);
    waitHistogram?.record((performance.now() - waiter.createdAt) / 1000, {
      pool: options.name ?? "data-pool",
    });
    recordPoolGauges();
    waiter.resolve(makeLease(resource));
    return true;
  }

  function releaseResource(resource: Resource): void {
    if (!state.active.delete(resource)) return;
    if (!state.draining && resolveWaiter(resource)) return;
    if (state.draining) {
      trackClose(resource);
      return;
    }
    state.idle.push(resource);
    recordPoolGauges();
  }

  async function closeResource(resource: Resource): Promise<void> {
    await resource.shutdown?.();
  }

  function trackClose(resource: Resource): Promise<void> {
    const closing = closeResource(resource)
      .catch((cause) => {
        state.closeErrors.push(cause);
      })
      .finally(() => {
        const index = state.closing.indexOf(closing);
        if (index >= 0) state.closing.splice(index, 1);
        state.total -= 1;
        recordPoolGauges();
        notifyDrainIfComplete();
      });
    state.closing.push(closing);
    return closing;
  }

  function trackStarting(starting: Promise<void>): void {
    const tracked = starting
      .catch((cause) => {
        state.closeErrors.push(cause);
      })
      .finally(() => untrackStarting(tracked));
    state.starting.push(tracked);
  }

  function untrackStarting(starting: Promise<void>): void {
    const index = state.starting.findIndex((candidate) => candidate === starting);
    if (index >= 0) state.starting.splice(index, 1);
    notifyDrainIfComplete();
  }

  function notifyDrainIfComplete(): void {
    if (state.active.size !== 0) return;
    if (state.starting.length !== 0) return;
    if (state.closing.length !== 0) return;
    while (state.drainResolvers.length > 0) {
      const waiter = state.drainResolvers.shift()!;
      if (state.closeErrors.length > 0) {
        waiter.reject(new AggregateError(state.closeErrors, "Pool resource shutdown failed"));
      } else {
        waiter.resolve();
      }
    }
  }

  const pool: Pool<Resource> = {
    name: options.name ?? "data-pool",

    async acquire(): Promise<PoolLease<Resource>> {
      if (state.draining) {
        throw new PoolError("Pool is draining");
      }

      const idle = state.idle.pop();
      if (idle !== undefined) {
        state.active.add(idle);
        recordPoolGauges();
        return makeLease(idle);
      }

      if (state.total < options.max) {
        const acquired = (async () => {
          const resource = await createResource();
          if (state.draining) {
            await trackClose(resource);
            throw new PoolError("Pool is draining");
          }
          state.active.add(resource);
          recordPoolGauges();
          return makeLease(resource);
        })();
        const starting = acquired.then(
          () => undefined,
          () => undefined,
        ).finally(() => untrackStarting(starting));
        state.starting.push(starting);
        return await acquired;
      }

      return await new Promise<PoolLease<Resource>>((resolve, reject) => {
        const timeout = options.acquireTimeoutMs;
        const waiter: Waiter<Resource> = {
          createdAt: performance.now(),
          resolve,
          reject,
          timer: timeout === undefined
            ? undefined
            : setTimeout(() => {
                const index = state.waiters.indexOf(waiter);
                if (index >= 0) state.waiters.splice(index, 1);
                reject(new PoolError("Timed out waiting for pool resource"));
              }, timeout),
        };
        state.waiters.push(waiter);
      });
    },

    stats(): PoolStats {
      return {
        active: state.active.size,
        idle: state.idle.length,
        waiting: state.waiters.length,
        total: state.total,
        draining: state.draining,
      };
    },

    async drain(): Promise<void> {
      state.draining = true;
      while (state.waiters.length > 0) {
        const waiter = state.waiters.shift()!;
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(new PoolError("Pool is draining"));
      }
      while (state.idle.length > 0) {
        const resource = state.idle.pop()!;
        trackClose(resource);
      }
      if (
        state.active.size === 0 &&
        state.starting.length === 0 &&
        state.closing.length === 0
      ) {
        if (state.closeErrors.length > 0) {
          throw new AggregateError(state.closeErrors, "Pool resource shutdown failed");
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        state.drainResolvers.push({ resolve, reject });
      });
    },

    async shutdown(): Promise<void> {
      await pool.drain();
    },
  };

  for (let index = 0; index < min; index += 1) {
    const starting = createResource().then(async (resource) => {
      if (state.draining) {
        await trackClose(resource);
      } else if (!resolveWaiter(resource)) {
        state.idle.push(resource);
        recordPoolGauges();
      }
    });
    trackStarting(starting);
  }

  return Object.freeze(pool);
}
