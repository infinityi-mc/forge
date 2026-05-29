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

Deferred: health probes (`Probe`/`AggregateHealth`, the standalone `Bun.serve` health server, `healthRoutes()`) and the full `lifecycle.*` metric/span surface land in **PR B**; first-class module adapters land in **PR C**.

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

```ts
import { forge, asComponent } from "forge/lifecycle";

let server: HttpServer;
const app = await forge.boot({
  config,
  components: [
    asComponent("telemetry", { stop: () => telemetry.shutdown() }),
    asComponent("db", {
      start: () => db.ping(),          // fail-fast if DB unreachable
      stop: () => db.shutdown(),
      healthcheck: async () => ({ status: "healthy", data: { ping: "ok" } }),
    }),
    asComponent("http", {
      start: () => { server = serve(router, { port: config.http.port }); },
      stop: () => server.stop(true),   // drain in-flight requests
    }),
  ],
  shutdownTimeout: 30_000,
  preStopDelayMs: 5_000,
});

app.logger.info("service started");
await app.done;                        // resolves after graceful shutdown
```

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
