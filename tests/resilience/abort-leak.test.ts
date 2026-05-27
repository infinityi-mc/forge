import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { combine, timeout, TimeoutError } from "../../src/resilience";

/**
 * Verifies the spec's headline guarantee (§B): when a timeout fires,
 * the `AbortSignal` passed through `ExecutionContext` aborts a real
 * `fetch`, causing the server to see request cancellation. This is
 * the "no leaked I/O" property that distinguishes forge from naive
 * `Promise.race(op, sleep)` libraries.
 */
describe("AbortSignal leak guarantee", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let aborted: number;
  let completed: number;

  beforeAll(() => {
    aborted = 0;
    completed = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              completed++;
              resolve();
            }, 5_000);
            req.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              aborted++;
              reject(new Error("client aborted"));
            });
          });
          return new Response("late");
        } catch {
          return new Response("aborted", { status: 499 });
        }
      },
    });
  });

  afterAll(async () => {
    await server?.stop(true);
  });

  test("timeout aborts an in-flight fetch at the socket level", async () => {
    const port = server!.port;
    const pipeline = combine(timeout({ ms: 50 }));

    const err = await pipeline
      .execute(async (ctx) => {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: ctx.signal,
        });
        return res.text();
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TimeoutError);

    // Give the server a moment to observe the close.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect(completed).toBe(0);
  });
});
