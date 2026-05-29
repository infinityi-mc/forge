# `forge/lifecycle`

The conductor of a Forge application. It owns the *order* components start in, the *reverse order* they stop in, the **readiness** flag that gates traffic, and how the process is brought down cleanly when the orchestrator sends `SIGTERM`.

```ts
import { forge } from "forge/lifecycle";
const app = await forge.boot({ config, components, shutdownTimeout: 30_000 });
await app.done; // resolves after a graceful, bounded shutdown
```

Every Forge module already exposes lifecycle seams (`db.shutdown()`, `HttpServer.stop()`, a messaging consumer's `start`/`stop`) — they just had nobody coordinating them. `forge/lifecycle` makes correct sequencing, the readiness gate, and a bounded graceful shutdown the *default* you get for free, so you stop shipping the classic production bugs: dropped in-flight requests, wrong stop order, traffic before ready, and hung shutdowns that get `SIGKILL`ed.

It is **not** a process supervisor, a clustering manager, a service mesh, or a DI container. It orchestrates the components inside a single process and hands the OS a clean exit.

---

## Shipped in PR A

1. **Core contracts** (`forge/lifecycle`) — `Component` (all-optional `start`/`stop`/`healthcheck` seam), `Application`, `LifecycleContext`, and `asComponent(name, hooks)` to wrap objects with differently-named methods (e.g. `db.shutdown` → `stop`).
2. **`forge.boot()`** — validates the component set (unique, non-empty names), installs signal handlers, then starts components in **array order** under a per-component `startTimeout`. If any `start()` rejects or overruns, boot **rolls back** (stops the already-started components in reverse) and rejects with a `StartupError`; the app never reaches `ready`.
3. **Bounded graceful shutdown** — triggered by a signal or `app.stop()`. Flips `ready=false`, optionally waits `preStopDelayMs` for load balancers to notice, then stops components in **strict reverse order**. Each `stop()` gets a slice of the remaining `shutdownTimeout` budget; a component that overruns its slice is **abandoned** (recorded, not thrown) so one bad component cannot consume the whole budget.
4. **`installSignalHandlers()`** (`forge/lifecycle/signals`) — `SIGTERM`/`SIGINT` by default, idempotent, with a double-signal escape hatch (a second identical signal forces `exit(1)`) and a disposer that removes every listener (no leaks between tests).
5. **Error taxonomy** (`forge/lifecycle/errors`) — `LifecycleError` base + `StartupError`, `ShutdownError`, `ShutdownTimeoutError`, `HealthCheckError`, `ComponentRegistrationError`.
6. **Injectable `exit` + `clock`** — the graceful-shutdown completion path calls `exit` (default `process.exit`, `0` normally / `1` if any stop failed or timed out). Every phase is timed with an injected `Clock` so tests never wait on real timers.
7. **`forge/lifecycle/testing`** — a deterministic `TestClock`, `fakeComponent(name, opts)` (records call order, can delay or throw), `createTestApp({ components })` (boots without real signal handlers, with a recorded `exit`), and `STANDARD_LIFECYCLE_SCENARIOS` + `assertConformance(bootFn?)`.

---

## Shipped in PR C

First-class **module adapters** (`forge/lifecycle/adapters`) so the Quick Start `components: [db, http, …]` "just works". Each wraps a Forge object into a `Component` with a sensible `healthcheck`, typed against a minimal structural `*Like` interface — **no hard dependency** on the other modules (the real objects already conform).

1. **`forge/data`**
   - `databaseComponent(name, db, opts?)` — `start` → `db.ping()` (fail-fast; disable with `pingOnStart: false`), `stop` → `db.shutdown()`, derived `healthcheck` pings and maps to `healthy` (`{ data: { ping: "ok" } }`) / `unhealthy`.
   - `poolComponent(name, pool, opts?)` — `stop` → `pool.shutdown()` (falls back to `drain()`); `healthcheck` from `stats()` (`draining` ⇒ `unhealthy`, else `healthy` with `{ active, idle, waiting }`).
2. **`forge/http`** — `httpServerComponent(name, server, opts?)` — `stop` → `server.stop(true)` to drain in-flight requests (`closeActiveConnections` configurable). Pair with `preStopDelayMs` so the LB sees `/readyz → 503` before the drain.
3. **`forge/messaging`** — `messageBusComponent` (`stop` → `flush()` then `shutdown()`) plus `consumerComponent` / `relayComponent` / `workerComponent` (map `start`/`stop`). Place them **after** the DB so they stop **before** it (strict reverse), letting in-flight handlers finish their writes.

Every adapter accepts an optional `healthcheck` override. Tests cover each mapping plus reverse-stop ordering through `boot`.

---

## Shipped in PR B

1. **Health probes** (`forge/lifecycle/health`) — `createProbe({ checks, ready, live, … })` returns a `Probe` with two questions:
   - `check()` — **readiness**: runs every registered check (each bounded by `checkTimeout`) and folds them **worst-of** (`healthy` < `degraded` < `unhealthy`). `critical: boolean` per check — a non-critical failure *degrades* but stays ready; a critical failure makes the app *not-ready*. Reports `ready` (boot gate AND no critical failure) and `uptimeMs`. A closed `ready` gate (startup/shutdown) short-circuits to not-ready **without** calling downstreams.
   - `liveness()` — deliberately cheap, reflects only the `live` gate and **never** calls downstream checks, so a dependency outage can't make an orchestrator kill the process.
2. **HTTP exposure** — two shapes for the same `Probe`:
   - `startHealthServer(probe, { port })` — a standalone `Bun.serve` on its own port (default `9000`), `/livez` + `/readyz`, `404` elsewhere; returns `{ port, url, stop() }`.
   - `healthRoutes(probe, opts)` — a framework-agnostic `handle(request) => Response | undefined` that mounts on a `forge/http` router (no extra port).
   - Both are k8s-shaped: `200` healthy/ready, `503` unhealthy/not-ready, JSON `AggregateHealth` body.
3. **`boot({ health })`** — when `health` is provided, `boot` starts the standalone server **before** components (so `/readyz` is `503` throughout startup) and tears it down at the end of shutdown (and on rollback). Checks are auto-derived from components that expose `healthcheck`.
4. **Observability** (`lifecycle.*`, opt-in) — with an injected `telemetry` handle, `boot`/shutdown emit `lifecycle.boot.duration`, `lifecycle.component.{start,stop}.duration` (labelled `component`/`outcome`), `lifecycle.shutdown.duration`, `lifecycle.component.stop.timeout`, `lifecycle.ready`, and `lifecycle.health.check.duration`, plus boot/shutdown/per-component spans. Every emit is guarded so telemetry being the *first-started* / *last-stopped* component can never throw into the orchestrator.
5. **Conformance** — `STANDARD_LIFECYCLE_SCENARIOS` gains **readiness gating** (closed gate / critical vs non-critical failure) and **liveness independence** scenarios.

---

## Design principles

1. **Bun first.** Signals via `process.on`, timers via native `setTimeout`/`AbortSignal`. No third-party runtime dependency.
2. **Interfaces first.** Built on the tiny `Component` seam — every Forge object already satisfies it structurally with zero changes.
3. **Observable by injection.** Telemetry/logger handles are structurally typed and opt-in; nothing is emitted (beyond the silent logger) without them. No hard import of `forge/telemetry`.
4. **Composable, not monolithic.** Use `installSignalHandlers()` without `boot()`; components are plain objects — no base class, no decorator registration.
5. **Fail-fast at boot.** A failing `start()` aborts boot and rolls back; the app never half-starts into a request-serving state.
6. **Zero magic.** Explicit wiring only — you pass `components` in dependency order. No auto-discovery, no DI container, no implicit global app.
7. **Bounded everything.** Every `start`, every `stop`, and the whole shutdown are time-boxed with an `AbortSignal`; a hung component cannot block the process forever.

---

## Ordering contract

Components start in **array order** and stop in **strict reverse order**. For `[telemetry, db, messaging, http]`, boot runs telemetry → db → messaging → http and shutdown runs http → messaging → db → telemetry, so the HTTP server stops accepting traffic *first* and telemetry flushes *last*.

---

## Module layout

```
src/lifecycle/
├── index.ts        # Public surface: forge, boot, asComponent, errors, types
├── types.ts        # Component, Application, BootOptions, LifecycleContext, Health*, Clock, structural Logger/Telemetry
├── errors.ts       # LifecycleError + StartupError / ShutdownError / ShutdownTimeoutError / HealthCheckError / ComponentRegistrationError
├── clock.ts        # realClock (Date.now + setTimeout, AbortSignal-aware)
├── component.ts    # asComponent() adapter
├── boot.ts         # forge.boot(): ordered start + rollback, Application factory
├── shutdown.ts     # reverse-order stop with per-component timeout slices
├── phase.ts        # silent logger, per-component child logger, bounded runPhase()
├── observability.ts # lifecycle.* metric surface + withSpan (opt-in, guarded)
├── adapters/
│   ├── index.ts    # databaseComponent, httpServerComponent, messaging adapters
│   ├── data.ts     # databaseComponent, poolComponent
│   ├── http.ts     # httpServerComponent
│   ├── messaging.ts # messageBus/consumer/relay/workerComponent
│   └── types.ts    # structural *Like seams + AdapterOptions
├── health/
│   ├── index.ts    # createProbe, healthRoutes, startHealthServer
│   ├── probe.ts    # worst-of aggregation + ready/uptime + bounded checks
│   ├── routes.ts   # framework-agnostic /livez + /readyz handlers
│   ├── server.ts   # standalone Bun.serve health server
│   └── types.ts    # Probe, AggregateHealth, HealthCheck, HealthServerOptions
├── signals/
│   ├── index.ts    # installSignalHandlers
│   └── types.ts    # SignalHandlerOptions, SignalSource
└── testing/
    ├── index.ts    # TestClock, fakeComponent, createTestApp
    ├── clock.ts    # deterministic TestClock
    └── conformance.ts # STANDARD_LIFECYCLE_SCENARIOS + assertConformance
```

---

## Quick start

With the official adapters (PR C), the dependency-ordered component list reads directly:

```ts
import {
  forge,
  asComponent,
  databaseComponent,
  httpServerComponent,
  consumerComponent,
} from "forge/lifecycle";

const server = serve(router, { port: config.http.port });
const app = await forge.boot({
  config,
  components: [
    // Dependency order — stopped in strict reverse.
    asComponent("telemetry", { stop: () => telemetry.shutdown() }),
    databaseComponent("db", db),          // ping on start, shutdown on stop, healthcheck
    consumerComponent("consumer", consumer), // stops before the db (reverse order)
    httpServerComponent("http", server),  // stop(true) drains in-flight requests
  ],
  shutdownTimeout: 30_000,
  preStopDelayMs: 5_000,                  // let the LB notice /readyz → 503
  health: { port: 9000 },                 // /livez + /readyz
  telemetry: { meter: telemetry.meter, tracer: telemetry.tracer },
  logger: telemetry.logger,
});

app.logger.info("service started");
await app.done;                          // resolves after graceful shutdown
```

`asComponent` is still there for anything custom or with non-standard method names.

---

## Health probes

Let `boot` run a standalone health server (k8s sidecar shape):

```ts
const app = await forge.boot({
  components: [db, http],
  health: { port: 9000 },              // /livez + /readyz on a separate port
});
// GET /readyz → 503 during startup/shutdown, 200 once ready
// GET /livez  → 200 unless the process is wedged
```

Or build a `Probe` yourself and mount it on an existing `forge/http` router with `healthRoutes()`:

```ts
import { createProbe, healthRoutes } from "forge/lifecycle/health";

const probe = createProbe({
  ready: () => app.ready,
  checks: [
    { name: "db", check: (ctx) => db.healthcheck(ctx) },          // critical (default)
    { name: "cache", critical: false, check: () => cache.ping() }, // degrades, stays ready
  ],
});
const routes = healthRoutes(probe);
// router.get("/readyz", (req) => routes.handle(req));
```

`check()` aggregates worst-of with the `critical` rule; `liveness()` stays cheap and never calls downstreams.

---

## Testing

```ts
import { describe, it, expect } from "bun:test";
import { createTestApp, fakeComponent } from "forge/lifecycle/testing";

it("stops components in reverse order", async () => {
  const events: string[] = [];
  const { app, exitCodes } = await createTestApp({
    components: ["db", "http"].map((n) => fakeComponent(n, { events })),
  });
  await app.stop();
  expect(events).toEqual(["db:start", "http:start", "http:stop", "db:stop"]);
  expect(exitCodes).toEqual([0]);
});
```

Validate a custom orchestrator against the shared invariants with `assertConformance`:

```ts
import { assertConformance } from "forge/lifecycle/testing";
await assertConformance(); // defaults to the stock forge.boot
```
