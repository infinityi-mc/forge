# `forge/telemetry`

The nervous system of a Forge application. Unifies the three pillars of observability — **logs**, **metrics**, and **traces** — under a single `TelemetryContext` propagated through `AsyncLocalStorage`.

Most observability libraries (including the official `@opentelemetry/*` JS SDK) are notoriously heavy and rely on monkey-patching. `forge/telemetry` is the opposite:

- **OTel-compatible, but lightweight.** We speak OTLP and use OTel data models, but we don't import the SDK. Exporters are implemented natively for Bun.
- **Context is king.** Logs, metrics, and traces are useless if they aren't correlated. Context propagation is built into the foundation.
- **Ergonomics over purity.** The API is designed for the 95% use case. The defaults just work.
- **No monkey-patching.** Instrumentation (tracing `fetch`, `bun:sqlite`, `pg`) ships as opt-in wrappers — no `require()` hijacking, no global side effects.

---

## Shipped today

1. `forge/telemetry/context` — trace ids, span ids, baggage, and W3C `traceparent` / `tracestate` / `baggage` propagation.
2. `forge/telemetry/log` — structured, contextual JSON logging with built-in middleware (`redact`, `sample`, `rateLimit`, `correlation`, `serialize`, `telemetry`) and a stdout exporter that auto-detects JSON vs. pretty output.
3. `forge/telemetry/meter` — counter, up-down counter, gauge, histogram with automatic in-memory aggregation, periodic + on-demand collection, recording / null / stdout exporters.
4. `forge/telemetry/trace` — `Tracer` + `Span` with W3C context bridge, samplers (`alwaysOn`, `alwaysOff`, `parentBased`, `ratio`), `simpleSpanProcessor` + `batchSpanProcessor`, recording / null / stdout exporters.
5. `forge/telemetry/exporters/otlp-http` — zero-dependency OTLP/HTTP **JSON** exporters for logs, metrics, traces, sharing a retry-aware transport.
6. `forge/telemetry/exporters/prometheus` — pull-based text-exposition exporter for the meter (`/metrics` endpoint).
7. `forge/telemetry/instrumentation/fetch` — opt-in `tracedFetch` wrapper that creates a client span per request and injects W3C headers.
8. `forge/telemetry/initTelemetry` — top-level factory that wires log + meter + trace around a single `Resource` with a unified `flush()` / `shutdown()`.
9. `forge/telemetry/testing` + `forge/telemetry/*/testing` — `createTestTelemetry()` aggregate plus recording exporters and conformance scenarios for verifying BYO exporters.

Upcoming: more instrumentation wrappers (`tracedSqlite`, `tracedPg`), OTLP/HTTP **protobuf** body encoder, OTLP/gRPC.

---

## Module layout

```
src/telemetry/
├── index.ts                          # cross-signal types (TelemetryError, Resource)
├── types.ts                          # Resource
├── errors.ts                         # TelemetryError
│
├── context/                          # W3C trace context + ALS-based propagation
├── log/                              # structured JSON logging
│
├── meter/
│   ├── index.ts                      # createMeter
│   ├── meter.ts                      # factory + periodic collection
│   ├── store.ts                      # in-memory series store + aggregation
│   ├── types.ts                      # Meter / Instrument / MetricData / MeterExporter
│   ├── errors.ts
│   ├── exporters/{stdout,null,recording}/
│   └── testing/                      # recordingMeterExporter
│
├── trace/
│   ├── index.ts                      # createTracer + samplers + processors
│   ├── tracer.ts                     # factory, span lifecycle, withSpan + context bridge
│   ├── types.ts                      # Tracer / Span / SpanProcessor / SpanExporter / Sampler
│   ├── errors.ts
│   ├── samplers/{always-on,always-off,parent-based,ratio}.ts
│   ├── processors/{simple,batch}.ts
│   ├── exporters/{stdout,null,recording}/
│   └── testing/                      # recordingSpanExporter
│
├── exporters/                        # cross-signal wire exporters
│   ├── otlp-http/                    # OTLP/HTTP JSON (logs + metrics + traces)
│   │   ├── transport.ts              # shared retry-aware HTTP client
│   │   ├── encoding.ts               # KeyValue / AnyValue / Resource encoders
│   │   ├── log.ts | meter.ts | trace.ts
│   │   └── index.ts
│   └── prometheus/                   # text exposition (meter)
│       ├── format.ts                 # MetricBatch → exposition text
│       ├── exporter.ts               # pull-based exporter with .render()
│       └── index.ts
│
├── instrumentation/                  # opt-in wrappers around external libs
│   └── fetch/                        # tracedFetch
│
├── init.ts                           # initTelemetry — top-level factory
└── testing/                          # createTestTelemetry — end-to-end harness
```

---

## Quick start

```ts
import { createLog } from "forge/telemetry/log";
import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";

const log = createLog({ exporter: stdoutExporter() });

log.info("server started", { port: 3000 });
log.warn("high memory usage", { mb: 512 });

try {
  await processPayment();
} catch (err) {
  log.error("payment failed", { err, orderId: "999" });
}
```

### Child loggers

Sub-systems get their own context via `child()`. Children inherit the parent's level, exporter, and middleware stack — middleware is **not** re-stacked per `child()` call.

```ts
const dbLog = log.child({ subsystem: "postgres" });
dbLog.debug("query executed", { durationMs: 14, rows: 5 });
```

### Auto-context

If a `TelemetryContext` is active when a log call happens, the logger attaches it to the record automatically — no parameter threading required.

```ts
import { withRootContext } from "forge/telemetry/context";

await withRootContext({ baggage: { tenantId: "acme" } }, async () => {
  log.info("processing");
  // → emitted record carries trace_id, span_id, and baggage.
});
```

### Middleware

Middleware composes outermost-first. `[a, b, c]` becomes `a(b(c(exporter)))`, so `a.export` runs first when the logger emits.

```ts
import { createLog } from "forge/telemetry/log";
import {
  correlation,
  rateLimit,
  redact,
  sample,
  serialize,
  telemetry,
} from "forge/telemetry/log/middleware";
import { stdoutExporter } from "forge/telemetry/log/exporters/stdout";

const log = createLog({
  exporter: stdoutExporter(),
  middleware: [
    redact({ paths: ["user.password"], patterns: [/Bearer\s+\S+/g] }),
    correlation(),
    serialize(),
    sample({ perSeverity: { debug: 0.1 } }),
    rateLimit({ recordsPerInterval: 1000, intervalMs: 60_000 }),
    telemetry({
      onDrop: ({ reason }) => metrics.inc(`log.drop.${reason}`),
      onError: () => metrics.inc("log.error"),
    }),
  ],
});
```

Place `telemetry()` after `sample()` and `rateLimit()` if you want `onDrop` events.

---

## Built-in middleware

| Middleware | Purpose |
| :--- | :--- |
| `redact({ paths, patterns, replacement })` | Replace sensitive values in attributes and messages before they leave the process. |
| `sample({ rate, perSeverity, bucketMs, random })` | Drop records by a keep rate. Defaults to deterministic hashing so the same record makes the same decision inside a bucket. |
| `rateLimit({ recordsPerInterval, intervalMs, burst, whenExceeded })` | Local token-bucket rate limit. Drops or throws when the bucket is empty. |
| `correlation({ keys, includeTraceIds, source })` | Promotes baggage + trace ids from the active `TelemetryContext` onto the record's `attributes` (where exporters serialize them). |
| `serialize({ errorKeys })` | Converts `Error` instances into plain objects so `JSON.stringify` works. Without this, `JSON.stringify(err)` returns `"{}"` because `Error`'s `name`/`message`/`stack` are non-enumerable. |
| `telemetry({ onWrite, onDrop, onError })` | Observes writes, drops, and exporter failures. Hook failures are swallowed so they cannot alter logger control flow. |

---

## Exporters

Every exporter implements the same contract:

```ts
interface LogExporter {
  export(record: LogRecord): void;
  flush?(options?: { signal?: AbortSignal }): Promise<void>;
  shutdown?(): Promise<void>;
}
```

### `forge/telemetry/log/exporters/stdout`

- `format: "auto"` (default), `"pretty"`, or `"json"`.
- Auto-detects TTY: pretty + ANSI colors on a terminal, JSON-per-line otherwise.
- Routes `warn`, `error`, `fatal` to stderr by default; opt out via `splitStreams: false`.
- Respects the [`NO_COLOR`](https://no-color.org) standard.
- Pretty format: `HH:MM:SS.mmm  LEVEL  message  key=value …`.

### `forge/telemetry/log/exporters/null`

Discards every record. Useful for silenced loggers and benchmarks.

### `forge/telemetry/log/exporters/recording`

Keeps every record in memory and exposes `records` + `reset()`. Test-only.

---

## Context (`forge/telemetry/context`)

```ts
import {
  withRootContext,
  withContext,
  currentContext,
  extract,
  inject,
  objectCarrier,
} from "forge/telemetry/context";

// At request entry — start a brand-new trace.
await withRootContext({ baggage: { tenantId: req.tenantId } }, () => handler(req));

// Or adopt an extracted context from incoming headers.
const ctx = extract(objectCarrier(req.headers));
if (ctx) await withContext(ctx, () => handler(req));

// Anywhere downstream — read the current trace id.
const ctx = currentContext();
```

Outgoing HTTP calls inject `traceparent` / `tracestate` / `baggage`:

```ts
const headers: Record<string, string> = {};
inject(currentContext()!, objectCarrier(headers));
await fetch(url, { headers });
```

---

## Error isolation

Exporter throws are isolated by default — a broken exporter cannot crash the host application. A single JSON fallback line is written to `process.stderr` when no `telemetry()` middleware is installed to observe the failure.

Set `propagateExporterErrors: true` to opt out of isolation and surface failures directly to the caller (useful in tests).

---

## Testing

```ts
import { createLog } from "forge/telemetry/log";
import { recordingExporter } from "forge/telemetry/log/testing";

const exp = recordingExporter();
const log = createLog({ exporter: exp });

log.info("served", { code: 200 });

expect(exp.records).toHaveLength(1);
expect(exp.records[0].message).toBe("served");
```

Conformance scenarios verify that any exporter (yours or shipped) honors the contract:

```ts
import {
  STANDARD_LOG_SCENARIOS,
  recordingTransport,
} from "forge/telemetry/log/testing";

for (const scenario of STANDARD_LOG_SCENARIOS) {
  const { exporter, records } = recordingTransport();
  await scenario.run(exporter);
  scenario.assert(records);
}
```

---

## Meter (`forge/telemetry/meter`)

```ts
import { createMeter } from "forge/telemetry/meter";
import { stdoutMeterExporter } from "forge/telemetry/meter/exporters/stdout";

const meter = createMeter({
  resource: { serviceName: "api" },
  exporter: stdoutMeterExporter(),
  intervalMs: 10_000, // export every 10s; 0 disables the timer
});

const requests = meter.createCounter("http.requests", { unit: "1" });
requests.add(1, { method: "GET", path: "/health" });

const inflight = meter.createUpDownCounter("http.inflight");
inflight.add(1);
// … later …
inflight.add(-1);

const memBytes = meter.createGauge("process.memory.heap", { unit: "By" });
memBytes.record(process.memoryUsage().heapUsed);

const latency = meter.createHistogram("http.duration", { unit: "ms" });
latency.record(42, { method: "POST", path: "/orders" });

// At shutdown:
await meter.shutdown();
```

| Instrument | Method | When to use |
| :--- | :--- | :--- |
| `Counter` | `.add(delta, attrs?)` (monotonic; negatives rejected) | request counts, bytes written, errors. |
| `UpDownCounter` | `.add(delta, attrs?)` (bi-directional) | queue depth, connection count, in-flight requests. |
| `Gauge` | `.record(value, attrs?)` (last value wins) | memory usage, temperature, current rate. |
| `Histogram` | `.record(value, attrs?)` | latencies, payload sizes. Default boundaries are latency-shaped (ms): `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`. |

Non-finite values (`NaN`, `Infinity`) are dropped silently. Negative deltas on a monotonic counter are dropped silently — use an up-down counter when both directions matter.

---

## Trace (`forge/telemetry/trace`)

```ts
import {
  createTracer,
  simpleSpanProcessor,
  parentBasedSampler,
  ratioSampler,
} from "forge/telemetry/trace";
import { stdoutSpanExporter } from "forge/telemetry/trace/exporters/stdout";

const tracer = createTracer({
  resource: { serviceName: "api" },
  sampler: parentBasedSampler({ root: ratioSampler({ rate: 0.1 }) }),
  processor: simpleSpanProcessor({ exporter: stdoutSpanExporter() }),
});

await tracer.withSpan("checkout", async (span) => {
  span.setAttribute("user.id", userId);
  await charge();
  span.setStatus({ code: "ok" });
});
```

`withSpan` automatically:

- inherits the active `TelemetryContext` (so `tracer.withSpan` nested inside an HTTP request becomes a child of the request span);
- ends the span when the callback returns or throws;
- on throw, sets status to `error` with the thrown message and rethrows.

### Samplers

| Sampler | Behavior |
| :--- | :--- |
| `alwaysOnSampler()` | Record every span. |
| `alwaysOffSampler()` | Drop every span. |
| `ratioSampler({ rate })` | Deterministic per-trace keep rate (`0..1`). |
| `parentBasedSampler({ root, parentSampled?, parentNotSampled? })` | Delegates based on the parent span's SAMPLED flag. Defaults inherit the parent's decision. |

### Processors

| Processor | Behavior |
| :--- | :--- |
| `simpleSpanProcessor({ exporter })` | Exports every span on `onEnd`. Good for tests + low-volume traces. |
| `batchSpanProcessor({ exporter, maxQueueSize?, maxExportBatchSize?, scheduledDelayMs?, exportTimeoutMs? })` | Bounded queue + timer-based batching. Recommended for production. Drops the oldest spans when the queue is full. |

---

## Wire exporters

### `forge/telemetry/exporters/otlp-http`

Zero-dependency OTLP/HTTP **JSON** exporters — one factory per signal, all sharing a retry-aware transport (exponential backoff with jitter; retries on 408/429/5xx; bails on other 4xx).

```ts
import { createLog } from "forge/telemetry/log";
import { createMeter } from "forge/telemetry/meter";
import { createTracer, batchSpanProcessor } from "forge/telemetry/trace";
import {
  otlpHttpLogExporter,
  otlpHttpMeterExporter,
  otlpHttpTraceExporter,
} from "forge/telemetry/exporters/otlp-http";

const resource = { serviceName: "api", environment: "production" };
const headers = { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY! };

const log = createLog({
  exporter: otlpHttpLogExporter({
    resource,
    url: "https://api.honeycomb.io/v1/logs",
    headers,
  }),
});

const meter = createMeter({
  resource,
  exporter: otlpHttpMeterExporter({
    url: "https://api.honeycomb.io/v1/metrics",
    headers,
  }),
});

const tracer = createTracer({
  resource,
  processor: batchSpanProcessor({
    exporter: otlpHttpTraceExporter({
      url: "https://api.honeycomb.io/v1/traces",
      headers,
    }),
  }),
});
```

Default endpoints follow the OTLP spec (`http://localhost:4318/v1/{logs,metrics,traces}`) so a local collector needs no config.

### `forge/telemetry/exporters/prometheus`

The Prometheus exposition format is pull-based; the exporter keeps the latest batch in memory and exposes a `render()` method.

```ts
import { createMeter } from "forge/telemetry/meter";
import { prometheusMeterExporter } from "forge/telemetry/exporters/prometheus";

const exporter = prometheusMeterExporter();
const meter = createMeter({
  resource: { serviceName: "api" },
  exporter,
  intervalMs: 1_000,
});

Bun.serve({
  port: 9100,
  fetch(req) {
    if (new URL(req.url).pathname === "/metrics") {
      return new Response(exporter.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
```

Up-down counters are emitted as Prometheus `gauge` (no monotonic constraint). Histograms produce `_bucket{le=...}` + `_sum` + `_count` lines with cumulative counts.

---

## Top-level factory — `initTelemetry`

`initTelemetry()` wires every signal around a single `Resource` and exposes a unified `flush()` / `shutdown()` that fan out across log + meter + trace without throwing — errors are returned per signal so the host process can decide how to recover.

```ts
import { initTelemetry } from "forge/telemetry";
import { stdoutExporter as stdoutLogExporter } from "forge/telemetry/log/exporters/stdout";
import { stdoutMeterExporter } from "forge/telemetry/meter/exporters/stdout";
import { stdoutSpanExporter } from "forge/telemetry/trace/exporters/stdout";

const t = initTelemetry({
  resource: { serviceName: "api", environment: "production" },
  log: { exporter: stdoutLogExporter(), level: "debug" },
  meter: { exporter: stdoutMeterExporter(), intervalMs: 10_000 },
  trace: { exporter: stdoutSpanExporter(), processor: "batch" },
});

t.log!.info("ready");
t.meter!.createCounter("http.requests").add(1);
await t.tracer!.withSpan("checkout", async () => { /* … */ });

process.on("SIGTERM", async () => {
  const result = await t.shutdown();
  if (result.trace?.ok === false) console.error(result.trace.error);
  process.exit(0);
});
```

Every section is independently optional — omit `log` / `meter` / `trace` and the corresponding member is `undefined`. The trace `processor` argument accepts `"simple"`, `"batch"` (default), `{ kind: "batch", maxQueueSize, … }`, or a fully-formed `SpanProcessor`.

---

## Instrumentation — `tracedFetch`

Opt-in wrapper around `fetch` that creates a client span per request and injects W3C `traceparent` / `tracestate` / `baggage` headers from the active context. No monkey-patching — consumers replace their `fetch` reference explicitly.

```ts
import { tracedFetch } from "forge/telemetry/instrumentation/fetch";

const fetch = tracedFetch({ tracer });

const res = await fetch("https://api.example.com/users", { method: "POST" });
// → span: "HTTP POST", kind=client, http.* + url.* + server.* attributes,
//   status=ok when 2xx/3xx/4xx, status=error when 5xx or thrown
```

Disable header injection per call site with `disablePropagation: true` (useful for cross-origin vendors that reject unknown headers). Override the span name with `spanName(input, init)` and add custom attributes with `attributes(input, init)`.

---

## End-to-end testing — `createTestTelemetry`

For consumers who want to assert across log + meter + trace at once, `createTestTelemetry()` wires `initTelemetry` with recording exporters for all three signals and exposes convenience getters.

```ts
import { createTestTelemetry } from "forge/telemetry/testing";

const t = createTestTelemetry();

await runHandlerUnderTest(t);

await t.flushAll();

expect(t.records).toHaveLength(2);
expect(t.batches[0]!.metrics[0]!.descriptor.name).toBe("http.requests");
expect(t.spans.map((s) => s.name)).toEqual(["checkout", "charge"]);
```

The trace processor defaults to `"simple"` so spans appear in `t.spans` synchronously on `span.end()`. The meter's background timer is disabled (`intervalMs: 0`) so collection is deterministic via `t.flushAll()`.

---

## Roadmap

- **Next:** more instrumentation wrappers (`tracedSqlite`, `tracedPg`), middleware-shaped HTTP server wiring.
- **Later:** OTLP/HTTP protobuf body encoder, OTLP/gRPC transport, Datadog-shaped JSON exporter.
