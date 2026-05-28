/**
 * `staticProvider` — a single-snapshot dynamic provider.
 *
 * Useful for tests (`defineDynamicConfig` against a fixed snapshot)
 * and for tiny apps that want the dynamic-config API surface without
 * any actual runtime updates.
 *
 * The provider never emits a second snapshot — `subscribe` accepts
 * the handler and returns an unsubscribe that does nothing. This
 * matches what consumers of feature-flag SDKs see in their first 100
 * milliseconds before the SDK has connected.
 *
 * @module
 */

import type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
} from "./types";

export interface StaticProviderOptions {
  /**
   * Stable identifier surfaced in diagnostics and the dynamic-update
   * log. Defaults to `"static"`.
   */
  name?: string;
}

/**
 * Build a provider that always returns the given snapshot.
 *
 * @example
 * ```ts
 * import { defineDynamicConfig, staticProvider, t } from "forge/config";
 *
 * const flags = await defineDynamicConfig(
 *   { features: { newCheckout: t.boolean.default(false) } },
 *   { provider: staticProvider({ "features.newCheckout": "true" }) },
 * );
 * flags.values.features.newCheckout; // → true
 * ```
 */
export function staticProvider(
  snapshot: DynamicConfigSnapshot,
  options: StaticProviderOptions = {},
): DynamicConfigProvider {
  const name = options.name ?? "static";
  return {
    name,
    get(): DynamicConfigSnapshot {
      return snapshot;
    },
    subscribe(_handler: DynamicSnapshotHandler): () => void {
      // No future updates — the provider is, by definition, static.
      // The unsubscribe function is a no-op.
      return () => {};
    },
  };
}
