import { describe, expect, test } from "bun:test";
import { withContext } from "../../../src/telemetry/context";
import {
  alwaysOffSampler,
  alwaysOnSampler,
  createTracer,
  parentBasedSampler,
  ratioSampler,
  simpleSpanProcessor,
} from "../../../src/telemetry/trace";
import { recordingSpanExporter } from "../../../src/telemetry/trace/testing";

const resource = { serviceName: "test" };

function makeTracer(opts: { sampler?: ReturnType<typeof alwaysOnSampler> } = {}) {
  const exporter = recordingSpanExporter();
  const tracer = createTracer({
    resource,
    sampler: opts.sampler,
    processor: simpleSpanProcessor({ exporter }),
  });
  return { tracer, exporter };
}

describe("createTracer — basic span lifecycle", () => {
  test("startSpan emits a single span on end", () => {
    const { tracer, exporter } = makeTracer();
    const span = tracer.startSpan("op");
    span.setAttribute("k", "v");
    span.end();

    expect(exporter.spans).toHaveLength(1);
    const s = exporter.spans[0]!;
    expect(s.name).toBe("op");
    expect(s.attributes["k"]).toBe("v");
    expect(s.status.code).toBe("unset");
    expect(s.parentSpanId).toBeUndefined();
  });

  test("end is idempotent", () => {
    const { tracer, exporter } = makeTracer();
    const span = tracer.startSpan("op");
    span.end();
    span.end();
    expect(exporter.spans).toHaveLength(1);
  });

  test("setStatus ok cannot be downgraded to error", () => {
    const { tracer, exporter } = makeTracer();
    const span = tracer.startSpan("op");
    span.setStatus({ code: "ok" });
    span.setStatus({ code: "error", message: "nope" });
    span.end();
    expect(exporter.spans[0]!.status.code).toBe("ok");
  });

  test("addEvent records timestamp + attributes", () => {
    const { tracer, exporter } = makeTracer();
    const span = tracer.startSpan("op");
    span.addEvent("cache.miss", { key: "user:42" });
    span.end();
    const events = exporter.spans[0]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("cache.miss");
    expect(events[0]!.attributes?.["key"]).toBe("user:42");
  });
});

describe("createTracer — parent/child", () => {
  test("withSpan creates a child of the active context", () => {
    const { tracer, exporter } = makeTracer();
    tracer.withSpan("parent", () => {
      tracer.withSpan("child", () => {});
    });
    expect(exporter.spans).toHaveLength(2);
    const [child, parent] = exporter.spans; // children end first
    expect(child!.name).toBe("child");
    expect(parent!.name).toBe("parent");
    expect(child!.traceId).toBe(parent!.traceId);
    expect(child!.parentSpanId).toBe(parent!.spanId);
  });

  test("startSpan inside withContext uses the context trace id", () => {
    const { tracer, exporter } = makeTracer();
    withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
      },
      () => {
        tracer.startSpan("op").end();
      },
    );
    const s = exporter.spans[0]!;
    expect(s.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(s.parentSpanId).toBe("b7ad6b7169203331");
  });

  test("options.root forces a fresh trace id even inside an active context", () => {
    const { tracer, exporter } = makeTracer();
    withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
      },
      () => {
        tracer.startSpan("root", { root: true }).end();
      },
    );
    const s = exporter.spans[0]!;
    expect(s.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(s.parentSpanId).toBeUndefined();
  });
});

describe("createTracer — withSpan error handling", () => {
  test("sync throw marks status error and rethrows", () => {
    const { tracer, exporter } = makeTracer();
    expect(() =>
      tracer.withSpan("op", () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(exporter.spans[0]!.status.code).toBe("error");
    expect(exporter.spans[0]!.status.message).toBe("nope");
  });

  test("async rejection marks status error and rethrows", async () => {
    const { tracer, exporter } = makeTracer();
    await expect(
      tracer.withSpan("op", async () => {
        throw new Error("async-nope");
      }),
    ).rejects.toThrow("async-nope");
    expect(exporter.spans[0]!.status.code).toBe("error");
  });

  test("async resolution ends the span after the promise settles", async () => {
    const { tracer, exporter } = makeTracer();
    const value = await tracer.withSpan("op", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return 42;
    });
    expect(value).toBe(42);
    expect(exporter.spans).toHaveLength(1);
  });
});

describe("samplers", () => {
  test("alwaysOff drops spans (no export)", () => {
    const { tracer, exporter } = makeTracer({ sampler: alwaysOffSampler() });
    tracer.startSpan("op").end();
    expect(exporter.spans).toHaveLength(0);
  });

  test("ratioSampler(0) drops everything", () => {
    const { tracer, exporter } = makeTracer({ sampler: ratioSampler({ rate: 0 }) });
    tracer.startSpan("op").end();
    expect(exporter.spans).toHaveLength(0);
  });

  test("ratioSampler(1) keeps everything", () => {
    const { tracer, exporter } = makeTracer({ sampler: ratioSampler({ rate: 1 }) });
    tracer.startSpan("op").end();
    expect(exporter.spans).toHaveLength(1);
  });

  test("parentBased — root delegate runs when there is no parent", () => {
    const { tracer, exporter } = makeTracer({
      sampler: parentBasedSampler({ root: alwaysOnSampler() }),
    });
    tracer.startSpan("op").end();
    expect(exporter.spans).toHaveLength(1);
  });

  test("parentBased — defers to parentNotSampled when parent has SAMPLED=0", () => {
    const { tracer, exporter } = makeTracer({
      sampler: parentBasedSampler({
        root: alwaysOffSampler(),
        parentNotSampled: alwaysOffSampler(),
        parentSampled: alwaysOnSampler(),
      }),
    });
    withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 0,
      },
      () => {
        tracer.startSpan("op").end();
      },
    );
    expect(exporter.spans).toHaveLength(0);
  });

  test("parentBased — defers to parentSampled when parent has SAMPLED=1", () => {
    const { tracer, exporter } = makeTracer({
      sampler: parentBasedSampler({
        root: alwaysOffSampler(),
        parentNotSampled: alwaysOffSampler(),
        parentSampled: alwaysOnSampler(),
      }),
    });
    withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
      },
      () => {
        tracer.startSpan("op").end();
      },
    );
    expect(exporter.spans).toHaveLength(1);
  });
});
