# `forge/resilience`

Composable fault tolerance for distributed systems. Wraps your business logic in **Policies** — retry, timeout, circuit-breaker, rate-limit, bulkhead, fallback, hedge — composed into **Pipelines** that share a single `AbortSignal` and integrate natively with `forge/telemetry`.

Most resilience libraries in the JS/TS ecosystem suffer from three problems: timeouts leak in-flight I/O, breakers are hidden globals, and composition kills type inference. `forge/resilience` solves all three:

- **Native `AbortSignal` propagation.** Pass `ctx.signal` to `fetch`, `bun:sqlite`, or any cooperating I/O. When a timeout fires, the socket actually closes — no orphaned promises consuming connections.
- **Explicit state.** Every circuit breaker / rate limiter / bulkhead is an object *you* construct and hold. Want one per tenant? Build a `Map<string, CircuitBreaker>`. No hidden singletons, no global registry.
- **Pipeline composition.** `combine(retry, timeout, breaker)` returns a typed `Pipeline` with generic-preserving `execute<T>`. No nested wrappers, no inference loss.
- **Telemetry by injection, not magic.** Every observable policy accepts an optional `telemetry: { meter, tracer }`. Standalone policies emit nothing. No globals.

---

## Shipped today (PR A)

1. **Core contract** (`forge/resilience`) — `Policy`, `Pipeline`, `ExecutionContext`, `Operation`, `combine(...)`, no-throw `executeResult` + `Result<T, E>`, base errors `ResilienceError` / `TransientError` / `RateLimitError`.
2. **`retry`** — `maxAttempts`, predicate-based `shouldRetry`, value-level `retryOn`, backoff strategies (`constantBackoff`, `linearBackoff`, `exponentialBackoff` with mandatory-by-default full jitter), injectable `clock`.
3. **`timeout`** — `optimistic` (default) and `pessimistic` strategies. Aborts a child `AbortController` linked to the operation so cooperating I/O actually cancels.
4. **`forge/resilience/testing`** — deterministic `TestClock` (`tickAsync(ms)` resolves pending sleeps instantly) + `executionContext()` factory for unit tests.

Upcoming:
- **PR B** — `circuitBreaker`, `rateLimit`, `bulkhead`.
- **PR C** — `fallback`, `hedge` (speculative + cancellation), `STANDARD_RESILIENCE_SCENARIOS` conformance suite.

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
├── telemetry/
│   └── instrumentation.ts  # buildInstruments({ meter, tracer })
│
└── testing/
    ├── index.ts          # TestClock, executionContext
    └── clock.ts          # TestClock implementation
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

| Metric                              | Type    |
| :---------------------------------- | :------ |
| `forge_resilience_attempts_total`   | counter |
| `forge_resilience_retries_total`    | counter |
| `forge_resilience_timeout_total`    | counter |

Plus span events `resilience.retry.attempt` and `resilience.timeout.triggered`.

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

---

## Constraints (out of scope by design)

- **No distributed state.** Rate limiters and breakers are in-memory, per-instance. 10 pods = 10 independent breakers. Distributed limits belong in your API gateway or a future `forge/distributed` module.
- **No auto-magic wrapping.** We do not monkey-patch `globalThis.fetch` or `http.request`. Wrap explicitly or use `forge/http` (TBD).
- **No persistent queues.** Bulkhead and rate-limit queues are in-memory. For crash-safe queues, use `forge/messaging` (TBD).
- **No workflow orchestration.** Not a state machine for long-running sagas — use Temporal / Inngest for that.
