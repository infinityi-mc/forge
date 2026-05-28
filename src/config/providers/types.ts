/**
 * `DynamicConfigProvider` — the read-and-subscribe interface every
 * dynamic config feed implements.
 *
 * Mirrors the structural shape of `LogExporter` / `SpanExporter` from
 * `forge/telemetry`: tiny, side-effect-light, trivially mockable.
 * Consumers BYO a provider for LaunchDarkly / AppConfig / a DB poll
 * / etc.; the library ships a `staticProvider` and a generic
 * `pollingProvider` only.
 *
 * @module
 */

/**
 * Raw snapshot returned by a provider. Keyed by **dotted schema path**
 * (e.g. `"features.maintenanceMode"`) — *not* env-var name — because
 * dynamic feeds (feature flag SaaS, AppConfig profiles, DB rows) think
 * in product-shaped namespaces, not env-var prefixes.
 *
 * Values are raw strings just like every other source in `forge/config`;
 * the same leaf parsers used by `defineConfig` coerce them to typed
 * values. Keys not present in the schema are silently ignored.
 */
export type DynamicConfigSnapshot = Readonly<Record<string, string>>;

/**
 * Callback fired when a provider produces a new snapshot. The
 * provider passes the snapshot verbatim — validation happens inside
 * `defineDynamicConfig`, never inside the provider.
 */
export type DynamicSnapshotHandler = (snapshot: DynamicConfigSnapshot) => void;

/**
 * Read-and-subscribe contract for dynamic configuration feeds.
 *
 * Lifecycle:
 *
 * 1. `defineDynamicConfig` calls `get()` once to seed the initial
 *    snapshot. The result is validated through the schema before
 *    the proxy is exposed.
 * 2. `defineDynamicConfig` calls `subscribe(handler)`. The returned
 *    unsubscribe function is invoked on `shutdown`.
 * 3. The provider invokes `handler` zero or more times with each
 *    subsequent snapshot. The provider does *not* deduplicate
 *    against the previous snapshot — that's `defineDynamicConfig`'s
 *    job, because dedup must compare typed values, not raw strings.
 * 4. On shutdown, `defineDynamicConfig` calls `unsubscribe()` then
 *    (if defined) `shutdown()`.
 */
export interface DynamicConfigProvider {
  /** Stable identifier for diagnostics and the dynamic-update log. */
  readonly name: string;

  /**
   * Return the current snapshot. May be sync or async — pollers that
   * keep a cached snapshot can return synchronously; one-shot feeds
   * that round-trip to an SDK may return a Promise.
   */
  get(): DynamicConfigSnapshot | Promise<DynamicConfigSnapshot>;

  /**
   * Subscribe to future snapshots. The provider MUST call `handler`
   * once for every distinct snapshot it observes. Returns an
   * unsubscribe function. Calling it idempotently is a hard
   * contract: `defineDynamicConfig` may invoke unsubscribe more than
   * once during shutdown teardown.
   */
  subscribe(handler: DynamicSnapshotHandler): () => void;

  /**
   * Drain any in-flight work. Optional. `defineDynamicConfig`'s
   * `flush()` delegates to this when present; otherwise it resolves
   * immediately.
   */
  flush?(): Promise<void>;

  /**
   * Release provider resources (timers, network connections). The
   * library always calls `unsubscribe` before calling `shutdown`, so
   * implementations only need to clean up provider-level state.
   */
  shutdown?(): Promise<void>;
}
