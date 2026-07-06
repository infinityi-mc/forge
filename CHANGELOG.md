# Changelog

## 1.3.0 - 2026-07-06

### Added

- Added trailing-`*` prefix wildcard topic subscriptions for built-in messaging transports, so consumers can subscribe to prefixes such as `system.*` across memory, SQLite, and PostgreSQL transports.
- Added messaging conformance coverage for prefix wildcard subscriptions so custom transports can validate the same routing behavior.

### Fixed

- Resolved `jsonFileStore` paths to absolute paths before registering file watchers, fixing watched same-directory relative paths such as `./preferences.json`.

### Changed

- Updated messaging and preference documentation for prefix wildcard subscriptions and absolute path resolution in `jsonFileStore`.

### Compatibility

- No breaking API changes are expected. Prefix wildcard matching is additive; non-trailing `*` characters remain literal, and `*` continues to mean catch-all.

## 1.2.1 - 2026-07-04

### Fixed

- Hardened lifecycle shutdown during startup so components that finish starting after a shutdown signal are still stopped before shutdown completes.
- Ensured startup rollback drains the started component list before any pending shutdown resumes, preventing duplicate component cleanup.
- Ensured `app.done` resolves only after shutdown cleanup and exit bookkeeping complete.
- Isolated lifecycle health and signal cleanup failures so they are logged without hiding the original startup or shutdown result.
- De-duplicated configured lifecycle signal handlers so duplicate signal names do not install leaked listeners or force premature exits.
- Rejected identical lifecycle health liveness/readiness paths so readiness cannot be shadowed by liveness.
- Ran readiness health checks concurrently under their per-check timeouts to avoid latency scaling linearly with check count.
- Removed an abort-listener leak in `realClock.sleep()`.

### Changed

- Updated lifecycle guide health-route and signal-handler examples to match the current `healthRoutes().handle()` and `installSignalHandlers({ onSignal })` APIs.

### Compatibility

- No breaking API changes are expected. The changes tighten lifecycle cleanup behavior and validation around ambiguous health route configuration.

## 1.2.0 - 2026-07-04

### Added

- Added first-class lifecycle adapters for additional Forge modules: `telemetryComponent()`, `configComponent()`, `preferenceComponent()`, and `securityComponent()`.
- Added structural adapter seams for telemetry, dynamic config, preferences, and security JWKS health without hard imports from sibling modules.
- Added lifecycle adapter tests covering shutdown delegation, healthcheck passthrough, derived security health, and security degraded-readiness behavior.

### Changed

- Updated lifecycle, README, and guide examples to prefer first-class lifecycle adapters over local `asComponent` boilerplate where Forge primitives already match an official adapter.
- Updated security guide examples to use the current JWKS key-store option names and lifecycle component shapes.

### Compatibility

- No breaking API changes are expected. The new adapters are additive exports from `forge/lifecycle` and `forge/lifecycle/adapters`.

## 1.1.0 - 2026-07-04

### Added

- Added structured `forge/preference` observability for load, save, external reload, and migration events.
- Added `mockPreferences` and `memoryStore` to `forge/preference/testing` for async-scoped preference tests.
- Added `forge/preference` documentation and examples covering stores, scopes, migrations, observability, and testing.

## 1.0.1 - 2026-06-12

### Added

- Added `./resilience/retry` and `./resilience/timeout` package subpath exports and JavaScript build entrypoints.
- Added `forge/resilience/testing` telemetry recording helpers via `createTestResilienceTelemetry()`.
- Added focused resilience conformance suites for bulkhead, fallback, rate-limit, policy composition, and deterministic clock scenarios.
- Added circuit-breaker state-change events with stable transition reasons and `onStateChange` observer support.
- Added circuit-breaker slow-call threshold support for detecting degraded successful dependencies.
- Added lifecycle readiness adapters for resilience policies through `circuitBreakerComponent()` and `bulkheadComponent()` in `forge/lifecycle/adapters`.
- Added opt-in `forge/resilience/config` schema fragments and pure option mappers for retry, timeout, circuit breaker, rate limit, bulkhead, fallback toggles, and hedge.
- Added opt-in `forge/resilience/messaging` circuit-breaker state publisher using a structural message bus interface.
- Added HTTP integration regression coverage for resilience pipeline cancellation, rate-limit mapping, and circuit-open error handling.

### Changed

- Updated resilience documentation with current integration status, best practices, lifecycle readiness examples, config helpers, messaging state publishing, and HTTP integration examples.
- Expanded package export tests to cover resilience policy subpaths, optional integration subpaths, errors, and testing surfaces.
- Circuit-breaker telemetry state-change events now include the transition reason.
- Circuit-breaker slow calls are tracked separately from failures so failure metrics preserve their original meaning.
- HTTP `problemDetails()` now maps structural `CircuitOpenError.retryAt` timestamps to `Retry-After` headers when the retry time is in the future.

### Fixed

- Ensured circuit-breaker observer callbacks cannot alter breaker admission behavior when they throw.
- Ensured circuit-breaker state publishing is best-effort: synchronous publish errors, asynchronous publish rejections, and `onError` failures are isolated from caller behavior.
- Ensured HTTP caller cancellation still aborts the underlying fetch when a resilience pipeline is present.
- Removed stale resilience documentation language that implied existing HTTP, messaging, and security seams were still missing.

### Compatibility

- No breaking API changes are expected for existing resilience users.
- New circuit-breaker slow-call behavior is disabled unless both `slowCallDurationMs` and `slowCallThreshold` are configured.
- New lifecycle, config, and messaging integrations are explicit opt-in surfaces and are not imported from the main `forge/resilience` barrel.
