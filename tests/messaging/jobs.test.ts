import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createJobQueue,
  createWorker,
  inMemoryJobStore,
  sqliteJobStore,
} from "../../src/messaging/jobs";
import { inMemoryDeadLetterStore } from "../../src/messaging/deadletter";
import { assertJobStoreConformance } from "../../src/messaging/testing";
import type { Clock } from "../../src/messaging";
import type { JobStore } from "../../src/messaging/jobs";

function mutableClock(start = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

async function drain(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createJobQueue + createWorker", () => {
  test("runs an enqueued job exactly once", async () => {
    const store = inMemoryJobStore();
    const queue = createJobQueue({ store });
    const seen: unknown[] = [];
    const worker = createWorker({
      store,
      pollIntervalMs: 5,
      handlers: {
        "email.send": (job) => {
          seen.push(job.payload);
        },
      },
    });
    await worker.start();
    await queue.enqueue("email.send", { to: "a@b.c" });
    await drain(() => seen.length === 1);
    await worker.stop();

    expect(seen).toEqual([{ to: "a@b.c" }]);
    expect(await store.size()).toBe(0);
  });

  test("does not run a scheduled job before its runAt", async () => {
    const clock = mutableClock(0);
    const store = inMemoryJobStore();
    const queue = createJobQueue({ store, clock });
    let ran = 0;
    const worker = createWorker({
      store,
      clock,
      pollIntervalMs: 5,
      handler: () => {
        ran += 1;
      },
    });
    await worker.start();
    await queue.schedule("later", new Date(10_000));

    // Worker is polling but the job's runAt is in the (clock) future.
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(0);

    clock.set(10_000);
    await drain(() => ran === 1);
    await worker.stop();
    expect(ran).toBe(1);
  });

  test("retries a failing job with backoff, then dead-letters it", async () => {
    const clock = mutableClock(0);
    const store = inMemoryJobStore();
    const queue = createJobQueue({ store, clock });
    const deadLetter = inMemoryDeadLetterStore();
    let attempts = 0;
    const worker = createWorker({
      store,
      clock,
      deadLetter,
      pollIntervalMs: 5,
      backoff: () => 0,
      handler: () => {
        attempts += 1;
        throw new Error("boom");
      },
    });
    await worker.start();
    await queue.enqueue("flaky", {}, { maxAttempts: 3 });

    await drain(async () => (await deadLetter.list()).length === 1, 2000);
    await worker.stop();

    expect(attempts).toBe(3);
    const parked = await deadLetter.list();
    expect(parked[0]?.attempts).toBe(3);
    expect(parked[0]?.message.type).toBe("flaky");
    expect(await store.size()).toBe(0);
  });

  test("every() re-schedules a recurring job (single-flight)", async () => {
    const clock = mutableClock(0);
    const store = inMemoryJobStore();
    const queue = createJobQueue({ store, clock });
    let runs = 0;
    const worker = createWorker({
      store,
      clock,
      pollIntervalMs: 5,
      handler: () => {
        runs += 1;
      },
    });

    // Two every() calls with the same name keep exactly one schedule.
    await queue.every("heartbeat", 1_000);
    await queue.every("heartbeat", 1_000);
    expect(await store.size()).toBe(1);

    await worker.start();
    await drain(() => runs >= 1);
    expect(await store.size()).toBe(1); // re-scheduled, not removed

    clock.advance(1_000);
    await drain(() => runs >= 2);
    await worker.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  test("an unknown job name is dead-lettered, not retried forever", async () => {
    const store = inMemoryJobStore();
    const queue = createJobQueue({ store });
    const deadLetter = inMemoryDeadLetterStore();
    const worker = createWorker({
      store,
      deadLetter,
      pollIntervalMs: 5,
      handlers: {},
    });
    await worker.start();
    await queue.enqueue("mystery", {});
    await drain(async () => (await deadLetter.list()).length === 1);
    await worker.stop();
    expect(await store.size()).toBe(0);
  });
});

describe("sqliteJobStore", () => {
  test("durably runs a job across a worker restart", async () => {
    const db = new Database(":memory:", { create: true });
    const store: JobStore = sqliteJobStore({ database: db });
    const queue = createJobQueue({ store });
    await queue.enqueue("durable.job", { n: 1 });

    // A fresh store over the same DB sees the persisted job.
    const store2 = sqliteJobStore({ database: db });
    const seen: unknown[] = [];
    const worker = createWorker({
      store: store2,
      pollIntervalMs: 5,
      handler: (job) => {
        seen.push(job.payload);
      },
    });
    await worker.start();
    await drain(() => seen.length === 1);
    await worker.stop();
    expect(seen).toEqual([{ n: 1 }]);
  });

  test("claims each job once across concurrent workers", async () => {
    const store = sqliteJobStore();
    const queue = createJobQueue({ store });
    const counts = new Map<string, number>();
    const worker = createWorker({
      store,
      concurrency: 4,
      pollIntervalMs: 2,
      handler: (job) => {
        const id = String((job.payload as { id: number }).id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      },
    });
    await worker.start();
    for (let i = 0; i < 25; i += 1) await queue.enqueue("work", { id: i });
    await drain(() => counts.size === 25, 3000);
    await worker.stop();

    expect(counts.size).toBe(25);
    for (const n of counts.values()) expect(n).toBe(1);
  });

  test("rejects an unsafe table name", () => {
    expect(() => sqliteJobStore({ table: "jobs; drop table x" })).toThrow();
  });
});

describe("JobStore conformance", () => {
  test("inMemoryJobStore satisfies the standard job-store scenarios", async () => {
    await assertJobStoreConformance(() => inMemoryJobStore());
  });

  test("sqliteJobStore satisfies the standard job-store scenarios", async () => {
    await assertJobStoreConformance(() => sqliteJobStore());
  });
});
