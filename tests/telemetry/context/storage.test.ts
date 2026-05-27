import { describe, expect, test } from "bun:test";
import {
  contextStorage,
  currentContext,
  TRACE_FLAGS,
  withContext,
  withRootContext,
} from "../../../src/telemetry/context";

describe("currentContext", () => {
  test("returns undefined outside any context", () => {
    expect(currentContext()).toBeUndefined();
  });
});

describe("withRootContext", () => {
  test("populates trace and span ids when none are active", () => {
    withRootContext({}, () => {
      const ctx = currentContext();
      expect(ctx).toBeDefined();
      expect(ctx!.traceId).toHaveLength(32);
      expect(ctx!.spanId).toHaveLength(16);
      expect(ctx!.traceFlags).toBe(TRACE_FLAGS.SAMPLED);
      expect(ctx!.baggage).toEqual({});
    });
  });

  test("allocates a fresh trace id even when a parent context is active", () => {
    withRootContext({}, () => {
      const outer = currentContext()!;
      withRootContext({}, () => {
        const inner = currentContext()!;
        expect(inner.traceId).not.toBe(outer.traceId);
        expect(inner.spanId).not.toBe(outer.spanId);
      });
    });
  });

  test("honors seed baggage", () => {
    withRootContext({ baggage: { tenantId: "acme" } }, () => {
      expect(currentContext()!.baggage).toEqual({ tenantId: "acme" });
    });
  });
});

describe("withContext", () => {
  test("inherits trace ids from parent when given partial override", () => {
    withRootContext({}, () => {
      const parent = currentContext()!;
      withContext({ baggage: { userId: "u1" } }, () => {
        const child = currentContext()!;
        expect(child.traceId).toBe(parent.traceId);
        expect(child.spanId).toBe(parent.spanId);
        expect(child.baggage).toEqual({ userId: "u1" });
      });
    });
  });

  test("merges baggage rather than replacing it", () => {
    withRootContext({ baggage: { a: "1" } }, () => {
      withContext({ baggage: { b: "2" } }, () => {
        expect(currentContext()!.baggage).toEqual({ a: "1", b: "2" });
      });
    });
  });

  test("partial context outside any parent gets fresh ids", () => {
    withContext({ baggage: { foo: "bar" } }, () => {
      const ctx = currentContext()!;
      expect(ctx.traceId).toHaveLength(32);
      expect(ctx.spanId).toHaveLength(16);
      expect(ctx.baggage).toEqual({ foo: "bar" });
    });
  });

  test("complete context is adopted verbatim", () => {
    const adopted = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TRACE_FLAGS.SAMPLED,
      baggage: { src: "ext" },
    };
    withContext(adopted, () => {
      expect(currentContext()).toEqual(adopted);
    });
  });
});

describe("AsyncLocalStorage propagation", () => {
  test("context survives await and setTimeout", async () => {
    await new Promise<void>((resolve) => {
      withRootContext({ baggage: { tag: "1" } }, async () => {
        const before = currentContext()!.traceId;
        await Promise.resolve();
        expect(currentContext()!.traceId).toBe(before);
        setTimeout(() => {
          expect(currentContext()!.traceId).toBe(before);
          resolve();
        }, 0);
      });
    });
  });

  test("two parallel contexts do not bleed into each other", async () => {
    const seen: string[] = [];
    await Promise.all([
      new Promise<void>((resolve) => {
        withRootContext({ baggage: { who: "A" } }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(currentContext()!.baggage["who"]!);
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        withRootContext({ baggage: { who: "B" } }, async () => {
          await new Promise((r) => setTimeout(r, 2));
          seen.push(currentContext()!.baggage["who"]!);
          resolve();
        });
      }),
    ]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  test("contextStorage is exported as a singleton", () => {
    expect(contextStorage).toBeDefined();
    contextStorage.run(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        baggage: {},
      },
      () => {
        expect(currentContext()!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      },
    );
  });
});
