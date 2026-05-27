# `forge/telemetry`

The nervous system of a Forge application. Unifies the three pillars of observability — **logs**, **metrics**, and **traces** — under a single `TelemetryContext` propagated through `AsyncLocalStorage`.

Most observability libraries (including the official `@opentelemetry/*` JS SDK) are notoriously heavy and rely on monkey-patching. `forge/telemetry` is the opposite:

- **OTel-compatible, but lightweight.** We speak OTLP and use OTel data models, but we don't import the SDK. Exporters are implemented natively for Bun.
- **Context is king.** Logs, metrics, and traces are useless if they aren't correlated. Context propagation is built into the foundation.
- **Ergonomics over purity.** The API is designed for the 95% use case. The defaults just work.
- **No monkey-patching.** Instrumentation (tracing `fetch`, `bun:sqlite`, `pg`) ships as opt-in wrappers — no `require()` hijacking, no global side effects.

---

## Scope of this PR

This PR delivers the foundation:

1. `forge/telemetry/context` — trace ids, span ids, baggage, and W3C `traceparent` / `tracestate` / `baggage` propagation.
2. `forge/telemetry/log` — structured, contextual JSON logging with built-in middleware (`redact`, `sample`, `rateLimit`, `correlation`, `serialize`, `telemetry`) and a stdout exporter that auto-detects JSON vs. pretty output.
3. `forge/telemetry/log/testing` — recording exporter + conformance scenarios for verifying BYO exporters.

`forge/telemetry/meter`, `forge/telemetry/trace`, the OTLP exporters, and `initTelemetry()` land in subsequent PRs.

---

## Module layout

```
src/telemetry/
├── index.ts                          # cross-signal types (TelemetryError, Resource)
├── types.ts                          # Resource
├── errors.ts                         # TelemetryError (signal-specific errors extend this)
│
├── context/
│   ├── index.ts                      # public surface
│   ├── ids.ts                        # genTraceId, genSpanId, validation
│   ├── storage.ts                    # AsyncLocalStorage, withContext, withRootContext
│   ├── propagation.ts                # W3C traceparent/tracestate/baggage
│   └── types.ts                      # TelemetryContext, TRACE_FLAGS
│
└── log/
    ├── index.ts                      # createLog, types
    ├── log.ts                        # factory + level filtering + context auto-injection
    ├── types.ts                      # LogRecord, LogExporter, LogMiddleware, Logger
    ├── serialize.ts                  # serializeError helper
    ├── errors.ts                     # LogError / LogExporterError / LogRateLimitError / …
    ├── middleware/
    │   ├── index.ts
    │   ├── redact.ts                 # PII redaction (paths + regex)
    │   ├── sample.ts                 # keep-rate, per-level overrides, deterministic or random
    │   ├── rate-limit.ts             # token bucket
    │   ├── correlation.ts            # pulls baggage + trace_id/span_id onto attributes
    │   ├── serialize.ts              # eager Error → plain-object conversion
    │   └── telemetry.ts              # onWrite / onDrop / onError observability
    ├── exporters/
    │   ├── stdout/                   # JSON or pretty, splits warn/error/fatal to stderr
    │   ├── null/                     # discards everything
    │   └── recording/                # in-memory buffer (testing)
    └── testing/                      # conformance scenarios + assertion helpers
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

## Roadmap

- **Next PR:** `forge/telemetry/meter` (counters, gauges, histograms), `forge/telemetry/trace` (spans, samplers, processors), OTLP/HTTP and Prometheus exporters.
- **Then:** opt-in instrumentation wrappers (`tracedFetch`, `tracedSqlite`, `tracedPg`), `initTelemetry()`, end-to-end `TestTelemetry` for asserting across all three signals at once.
