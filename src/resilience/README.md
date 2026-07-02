# `forge/resilience`

Composable fault tolerance for distributed systems. Wraps your business logic in **Policies** — retry, timeout, circuit-breaker, rate-limit, bulkhead, fallback, hedge — composed into **Pipelines** that share a single `AbortSignal` and integrate natively with `forge/telemetry`.

Most resilience libraries in the JS/TS ecosystem suffer from three problems: timeouts leak in-flight I/O, breakers are hidden globals, and composition kills type inference. `forge/resilience` solves all three:

- **Native `AbortSignal` propagation.** Pass `ctx.signal` to `fetch`, `bun:sqlite`, or any cooperating I/O. When a timeout fires, the socket actually closes — no orphaned promises consuming connections.
- **Explicit state.** Every circuit breaker / rate limiter / bulkhead is an object *you* construct and hold. Want one per tenant? Build a `Map<string, CircuitBreaker>`. No hidden singletons, no global registry.
- **Pipeline composition.** `combine(retry, timeout, breaker)` returns a typed `Pipeline` with generic-preserving `execute<T>`. No nested wrappers, no inference loss.
- **Telemetry by injection, not magic.** Every observable policy accepts an optional `telemetry: { meter, tracer }`. Standalone policies emit nothing. No globals.

---

## Shipped today (PR A + PR B + PR C)

1. **Core contract** (`forge/resilience`) — `Policy`, `Pipeline`, `ExecutionContext`, `Operation`, `combine(...)`, no-throw `executeResult` + `Result<T, E>`, base errors `ResilienceError` / `TransientError` / `RateLimitError`.
2. **`retry`** — `maxAttempts`, predicate-based `shouldRetry`, value-level `retryOn`, backoff strategies (`constantBackoff`, `linearBackoff`, `exponentialBackoff` with mandatory-by-default full jitter), injectable `clock`.
3. **`timeout`** — `optimistic` (default) and `pessimistic` strategies. Aborts a child `AbortController` linked to the operation so cooperating I/O actually cancels.
4. **`circuitBreaker`** — three-state breaker (closed / open / half-open), count- or time-based sliding window, ratio or absolute thresholds, `forceOpen()` / `forceClosed()` / `reset()` inspectors. Explicit instantiation: hold one per dependency or build a `Map` for per-tenant breakers.
5. **`rateLimit`** — token-bucket (burst-friendly) and sliding-window (strict) algorithms, `throw` and `wait` modes, bounded waiter queue, abort-aware waits.
6. **`bulkhead`** — concurrency-limiting semaphore with a bounded wait queue; `BulkheadFullError` when both slots and queue are saturated.
7. **`fallback`** — substitute a secondary result when the primary fails; predicate-gated; preserves the original error on `cause`.
8. **`hedge`** — fire speculative parallel attempts on a delay schedule. First to succeed wins; losers are aborted via their own `AbortSignal` so cooperating I/O actually cancels.
9. **`forge/resilience/testing`** — deterministic `TestClock`, `executionContext()` / `createTestResilience()` factories, a standalone `createTestResilienceTelemetry()` double, and standard plus policy-specific conformance suites so wrappers around the canonical policies stay drop-in compatible.

---

## Module layout

```
src/resilience/
├── index.ts              # Public surface (combine, retry, timeout, errors, types)
├── types.ts              # Policy, Pipeline, ExecutionContext, Operation, Clock, BackoffStrategy
├── errors.ts             # ResilienceError, TransientError, RateLimitError
├── result.ts             # Result<T, E>, ok, err, isOk, isErr
├── clock.ts              # realClock (Date.now + setTimeout)
├── context.ts            # buildRootContext, withExecutionContext
├── pipeline.ts           # combine(...) — outermost-first fold
│
├── retry/
│   ├── index.ts          # retry, exponentialBackoff, RetryExhaustedError, …
│   ├── retry.ts          # Implementation
│   ├── backoff.ts        # constant / linear / exponential strategies
│   ├── errors.ts         # RetryExhaustedError
│   └── types.ts          # RetryOptions, RetryPolicy, RetryPredicate, RetryValuePredicate
│
├── timeout/
│   ├── index.ts          # timeout, TimeoutError
│   ├── timeout.ts        # Implementation (child AbortController + Promise.race)
│   ├── errors.ts         # TimeoutError
│   └── types.ts          # TimeoutOptions, TimeoutPolicy, TimeoutStrategy
│
├── circuit-breaker/
│   ├── index.ts          # circuitBreaker, CircuitOpenError
│   ├── breaker.ts        # CLOSED / OPEN / HALF_OPEN state machine
│   ├── sliding-window.ts # count- and time-based windows
│   ├── errors.ts         # CircuitOpenError
│   └── types.ts          # CircuitBreakerOptions, CircuitBreakerPolicy, CircuitState
│
├── rate-limit/
│   ├── index.ts          # rateLimit, RateLimitedError
│   ├── rate-limit.ts     # Policy + queueing
│   ├── token-bucket.ts   # Burst-friendly admission
│   ├── sliding-window.ts # Strict rolling-window admission
│   ├── errors.ts         # RateLimitedError
│   └── types.ts          # RateLimitOptions, RateLimitPolicy, RateLimitMode
│
├── bulkhead/
│   ├── index.ts          # bulkhead, BulkheadFullError
│   ├── bulkhead.ts       # Policy
│   ├── semaphore.ts      # Bounded async semaphore + wait queue
│   ├── errors.ts         # BulkheadFullError
│   └── types.ts          # BulkheadOptions, BulkheadPolicy
│
├── fallback/
│   ├── index.ts          # fallback
│   ├── fallback.ts       # Policy
│   └── types.ts          # FallbackOptions, FallbackPolicy, FallbackHandler
│
├── hedge/
│   ├── index.ts          # hedge, HedgeCancelledError
│   ├── hedge.ts          # Policy (speculative parallel attempts)
│   ├── errors.ts         # HedgeCancelledError
│   └── types.ts          # HedgeOptions, HedgePolicy
│
├── telemetry/
│   └── instrumentation.ts  # buildInstruments({ meter, tracer })
│
└── testing/
    ├── index.ts          # TestClock, executionContext, createTestResilience
    ├── clock.ts          # TestClock implementation
    ├── conformance.ts    # Standard and policy-specific conformance suites
    └── telemetry.ts      # Standalone resilience telemetry test double
```

---

## Quick start

```ts
import {
  combine,
  exponentialBackoff,
  retry,
  timeout,
  TransientError,
} from "forge/resilience";

const pipeline = combine(
  retry({
    maxAttempts: 3,
    backoff: exponentialBackoff({ initial: 100, max: 2_000 }),
    shouldRetry: (err) => err instanceof TransientError,
  }),
  timeout({ ms: 2_000 }),
);

const data = await pipeline.execute(async (ctx) => {
  // ctx.signal aborts when the timeout fires — cooperating fetch
  // cancels at the socket level.
  const res = await fetch(url, { signal: ctx.signal });
  if (res.status >= 500) throw new TransientError("upstream 5xx");
  return res.json();
});
```

### No-throw with `executeResult`

```ts
const outcome = await pipeline.executeResult(async (ctx) => {
  const res = await fetch(url, { signal: ctx.signal });
  return res.json();
});

if (outcome.isOk()) {
  console.log(outcome.value);
} else {
  console.error(outcome.error); // ResilienceError subclass
}
```

### With telemetry

```ts
import { initTelemetry } from "forge/telemetry";
// …configure exporters…
const t = initTelemetry({ /* … */ });

const pipeline = combine(
  retry({
    maxAttempts: 3,
    telemetry: { meter: t.meter, tracer: t.tracer },
  }),
  timeout({
    ms: 2_000,
    telemetry: { meter: t.meter, tracer: t.tracer },
  }),
);
```

Emits:

| Metric                                | Type    |
| :------------------------------------ | :------ |
| `forge_resilience_attempts_total`     | counter |
| `forge_resilience_retries_total`      | counter |
| `forge_resilience_timeout_total`      | counter |
| `forge_resilience_circuit_state`      | gauge   |
| `forge_resilience_bulkhead_queue_size`| gauge   |

Plus span events `resilience.retry.attempt`, `resilience.timeout.triggered`, `resilience.circuit.state_change`, `resilience.fallback.triggered`, and `resilience.hedge.attempt`.

### Degrading gracefully with `fallback`

```ts
import { combine, fallback, retry, timeout } from "forge/resilience";

const pipeline = combine(
  fallback({
    fallback: () => ({ items: [], stale: true }),
    shouldFallback: (err) => !(err instanceof AuthError),
  }),
  retry({ maxAttempts: 3 }),
  timeout({ ms: 2_000 }),
);

// On success: returns the live result. On failure: returns the stale
// stub, with the original error preserved on `cause` if the fallback
// itself throws.
const data = await pipeline.execute(async (ctx) => {
  const res = await fetch(url, { signal: ctx.signal });
  return res.json();
});
```

### Cutting tail latency with `hedge`

```ts
import { combine, hedge } from "forge/resilience";

const pipeline = combine(
  // Fire a second request 50ms after the first if it hasn't returned
  // yet. Up to 3 attempts run concurrently. Losers are aborted via
  // their own AbortSignal — pass it to fetch so the socket closes.
  hedge({ delay: 50, maxHedgedAttempts: 3 }),
);

await pipeline.execute(async (ctx) => {
  return fetch(url, { signal: ctx.signal });
});
```

### Testing deterministically

```ts
import { describe, expect, test } from "bun:test";
import { retry, exponentialBackoff } from "forge/resilience";
import { TestClock, executionContext } from "forge/resilience/testing";

test("retries with exponential backoff", async () => {
  const clock = new TestClock();
  const policy = retry({
    maxAttempts: 3,
    backoff: exponentialBackoff({ initial: 100, jitter: false }),
    clock,
  });

  let attempts = 0;
  const promise = policy.execute(() => {
    attempts++;
    if (attempts < 3) throw new Error("fail");
    return "ok";
  }, executionContext());

  await Promise.resolve(); await Promise.resolve();
  await clock.tickAsync(100); // first backoff
  await clock.tickAsync(200); // second backoff

  expect(await promise).toBe("ok");
});
```

Verifying that a custom pipeline still satisfies the shared invariants:

```ts
import { combine, retry, timeout } from "forge/resilience";
import {
  STANDARD_RESILIENCE_SCENARIOS,
  assertConformance,
  createTestResilience,
} from "forge/resilience/testing";

const t = createTestResilience();
await assertConformance(
  () => combine(retry({ maxAttempts: 1, clock: t.clock }), timeout({ ms: 100, clock: t.clock })),
  STANDARD_RESILIENCE_SCENARIOS,
);
```

### Standalone telemetry tests

```ts
import { retry } from "forge/resilience";
import {
  TestClock,
  createTestResilienceTelemetry,
} from "forge/resilience/testing";

const telemetry = createTestResilienceTelemetry();
const clock = new TestClock();
const policy = retry({ maxAttempts: 2, telemetry: telemetry.telemetry, clock });

// Execute the policy, then assert against telemetry.metrics and
// telemetry.spanEvents without importing forge/telemetry/testing.
```

---

## Integration status

- **HTTP client**: `forge/http/client` accepts a structural resilience pipeline through `createHttpClient({ resilience })`.
- **HTTP middleware**: `forge/http/middleware` includes `rateLimit({ limiter })`, and `problemDetails()` maps structural rate-limit and circuit-open errors to RFC 7807 responses.
- **Lifecycle**: `forge/lifecycle/adapters` exposes readiness components for circuit breakers and bulkheads.
- **Config**: `forge/resilience/config` exposes opt-in schema fragments and pure option mappers.
- **Messaging**: consumers, jobs, and outbox relays accept retry policies structurally; policy state remains owned by the application.
- **Messaging state events**: `forge/resilience/messaging` can publish circuit-breaker state changes through a structural message bus.
- **Security**: JWKS key stores accept a structural pipeline for resilient cache fetches.

### HTTP integration

```ts
import { createHttpClient } from "forge/http/client";
import { combine, timeout } from "forge/resilience";

const client = createHttpClient({
  baseUrl: "https://payments.internal",
  resilience: combine(timeout({ ms: 2_000 })),
});

const payment = await client.get("/payments/pay_123");
```

The client accepts any structural pipeline with `execute(op)`. Its fetch signal combines caller cancellation, client deadlines, and the resilience pipeline signal, so a timeout aborts the underlying socket.

```ts
import { problemDetails, rateLimit } from "forge/http/middleware";
import { createRouter } from "forge/http/server";
import { combine, rateLimit as resilienceRateLimit } from "forge/resilience";

const limiter = combine(resilienceRateLimit({
  algorithm: { kind: "sliding-window", limit: 100, windowMs: 60_000 },
}));

const router = createRouter()
  .use(problemDetails())
  .use(rateLimit({ limiter }));
```

`problemDetails()` maps resilience rate-limit errors to `429` with `Retry-After`, and circuit-open errors to `503` with `Retry-After` when the error exposes a future `retryAt` timestamp.

### Lifecycle readiness

```ts
import { circuitBreaker, bulkhead } from "forge/resilience";
import {
  circuitBreakerComponent,
  bulkheadComponent,
} from "forge/lifecycle/adapters";

const breaker = circuitBreaker({ failureThreshold: 0.5, resetTimeoutMs: 30_000 });
const limiter = bulkhead({ maxConcurrent: 20, maxQueue: 50 });

const components = [
  circuitBreakerComponent("payments-breaker", breaker),
  bulkheadComponent("payments-bulkhead", limiter),
];
```

These adapters are readiness checks, not liveness kill switches: an open breaker is `unhealthy` by default, a half-open breaker is `degraded`, and a bulkhead with queued callers is `degraded` unless `unhealthyAtSaturation` is enabled.

### Config helpers

```ts
import { defineConfig } from "forge/config";
import {
  resilienceConfigSchema,
  retryOptionsFromConfig,
  timeoutOptionsFromConfig,
} from "forge/resilience/config";
import { combine, retry, timeout } from "forge/resilience";

const config = defineConfig({ resilience: resilienceConfigSchema });

const pipeline = combine(
  retry(retryOptionsFromConfig(config.resilience.retry)),
  timeout(timeoutOptionsFromConfig(config.resilience.timeout)),
);
```

The helpers are schema fragments and mappers only. They do not load config globally, and policy constructors still enforce numeric range validation.

### Circuit state messages

```ts
import { circuitBreaker } from "forge/resilience";
import { circuitBreakerStatePublisher } from "forge/resilience/messaging";

const breaker = circuitBreaker({
  failureThreshold: 0.5,
  resetTimeoutMs: 30_000,
  onStateChange: circuitBreakerStatePublisher({
    bus,
    source: "payments",
    headers: { service: "checkout" },
    onError: (error) => logger.warn("failed to publish breaker state", { error }),
  }),
});
```

Publishing is best-effort and observational. A publish failure is sent to `onError` when provided and never changes breaker admission behavior.

## Best practices

- Build one breaker, limiter, or bulkhead per isolated dependency or tenant; sharing one instance across unrelated dependencies couples their failure modes.
- Put `retry` outside `timeout` when each attempt needs its own deadline, and pass `ctx.signal` to the underlying I/O.
- Use `TestClock` for policy tests that involve sleeps, backoff, timeout, rate-limit wait mode, or hedge delay.
- Run `STANDARD_RESILIENCE_SCENARIOS` against wrapper pipelines and the focused policy-specific suites when adapting policy-like implementations.

## Common pitfalls

- A timeout only cancels work that observes `ctx.signal`; ignoring the signal leaves background I/O running.
- In-memory breaker, limiter, bulkhead, and wait-queue state is per process, not distributed across replicas.
- `fallback` is a degraded answer, not a retry budget. Place it outside retry if fallback should run only after retries are exhausted.
- `hedge` can increase upstream load. Use bounded attempts and ensure losing attempts receive and honor abort signals.

---

## Constraints (out of scope by design)

- **No distributed state.** Rate limiters and breakers are in-memory, per-instance. 10 pods = 10 independent breakers. Distributed limits belong in your API gateway or a future `forge/distributed` module.
- **No auto-magic wrapping.** We do not monkey-patch `globalThis.fetch` or `http.request`. Wrap explicitly or pass a resilience pipeline to `forge/http/client`.
- **No persistent queues.** Bulkhead and rate-limit queues are in-memory. For crash-safe queues, use `forge/messaging`.
- **No workflow orchestration.** Not a state machine for long-running sagas — use Temporal / Inngest for that.
