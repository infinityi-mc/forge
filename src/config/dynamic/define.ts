/**
 * `defineDynamicConfig` — the runtime-mutable counterpart to
 * `defineConfig`.
 *
 * Pipeline:
 *
 * 1. Pull the initial snapshot from the provider.
 * 2. Validate it through the same `validateSnapshot` core that
 *    powers `defineConfig`. Initial validation failure throws
 *    `ConfigValidationError` — the dynamic loader is intended to be
 *    awaited inside `main()`, so a throw is the right shape (no
 *    process exit, the host decides how to react).
 * 3. Deep-freeze the validated tree, store it in a `SnapshotRef`,
 *    and wrap that ref in a Proxy that always reads the latest
 *    snapshot.
 * 4. Subscribe to the provider. On each update: validate, freeze,
 *    swap the ref, fire `onChange(old, new, changedKeys)`, emit a
 *    `Dynamic config updated` log line.
 * 5. Provider / onChange errors are isolated by default and routed
 *    to the logger; the polling loop never crashes. Opt into
 *    `propagateProviderErrors: true` to receive a
 *    `ConfigProviderError` on the next `flush()` / `shutdown()`.
 *
 * @module
 */

import {
  ConfigProviderError,
  ConfigValidationError,
} from "../errors";
import type { Logger } from "../logger";
import {
  emitDynamicUpdate,
  emitProviderError,
} from "../observability";
import type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
} from "../providers/types";
import { deepFreeze } from "../schema/walk";
import type { ConfigSchema, Infer } from "../types";
import { validateSnapshot } from "../validate";
import { diff } from "./diff";
import { createSnapshotProxy, type SnapshotRef } from "./proxy";

/**
 * Options accepted by {@link defineDynamicConfig}.
 *
 * The `provider` is the only required field. `onChange` is the most
 * common addition — it gets the old + new typed configs and a sorted
 * list of changed dotted paths.
 */
export interface DefineDynamicConfigOptions<S extends ConfigSchema> {
  /**
   * The data feed. {@link defineDynamicConfig} calls `get()` once at
   * boot, then subscribes for the lifetime of the returned handle.
   */
  provider: DynamicConfigProvider;
  /**
   * Fired *after* a new snapshot has been validated, frozen, and
   * swapped into the live view. The handler receives the previous
   * tree, the new tree, and the list of dotted paths that changed.
   * Callbacks that throw are isolated unless
   * `propagateProviderErrors: true`.
   */
  onChange?: (
    oldConfig: Infer<S>,
    newConfig: Infer<S>,
    changedKeys: readonly string[],
  ) => void;
  /**
   * Optional structured logger. Emits:
   * - `warn "Dynamic config updated"` on every snapshot swap.
   * - `error "Dynamic config provider error"` whenever the provider
   *   (`subscribe` / `update` / `shutdown` / `flush`) or the
   *   `onChange` callback throws and errors are isolated.
   *
   * When **no** logger is supplied **and** `propagateProviderErrors`
   * is `false` (the default), isolated errors are silently dropped.
   * For production deployments either supply a `logger` or set
   * `propagateProviderErrors: true` so failures are observable.
   */
  logger?: Logger;
  /**
   * Default `false`: errors from `subscribe` / runtime update
   * validation / `onChange` / `provider.shutdown()` / `provider.flush()`
   * are caught and routed to the optional `logger`. The polling loop
   * keeps running.
   *
   * Set `true` to let the first-seen such error bubble up as a
   * {@link ConfigProviderError} from the next `flush()` /
   * `shutdown()` call (the live view is still preserved with the
   * last-good snapshot until then). Useful when the host application
   * has its own crash-on-startup-failure policy.
   *
   * Note: when both `propagateProviderErrors` is `false` **and** no
   * `logger` is supplied, isolated errors have no surface and are
   * dropped — supply at least one to keep failures observable.
   * Errors from the *initial* fetch and the *initial* validation
   * always throw regardless of this flag, because without a valid
   * seed snapshot there is nothing to return.
   */
  propagateProviderErrors?: boolean;
}

/**
 * Live handle returned by {@link defineDynamicConfig}.
 *
 * `values` is the Proxy you read from. Reading the same key after a
 * provider update returns the updated value; capturing a nested
 * subtree pins it to the snapshot in effect at the time of capture
 * (see the README "Reading dynamic config" section).
 *
 * `flush()` / `shutdown()` follow the same shape as
 * `forge/telemetry/log`'s lifecycle. `[Symbol.asyncDispose]` is
 * provided so callers using TS 5.2+ `await using` semantics get
 * automatic teardown.
 */
export interface DynamicConfigHandle<S extends ConfigSchema> {
  /** Live Proxy view of the validated tree. */
  readonly values: Infer<S>;
  /** Drain any in-flight provider work. Delegates to `provider.flush?`. */
  flush(): Promise<void>;
  /** Stop subscribing to the provider and release resources. */
  shutdown(): Promise<void>;
  /** TS 5.2+ disposable hook — aliases `shutdown()`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Load + subscribe to a dynamic configuration source.
 *
 * @example Static snapshot
 * ```ts
 * import { defineDynamicConfig, staticProvider, t } from "forge/config";
 *
 * const flags = await defineDynamicConfig(
 *   { features: { maintenanceMode: t.boolean.default(false) } },
 *   { provider: staticProvider({ "features.maintenanceMode": "false" }) },
 * );
 * if (flags.values.features.maintenanceMode) {
 *   // …
 * }
 * await flags.shutdown();
 * ```
 *
 * @example Polling provider
 * ```ts
 * import { defineDynamicConfig, pollingProvider, t } from "forge/config";
 *
 * const flags = await defineDynamicConfig(schema, {
 *   provider: pollingProvider({
 *     name: "app-config",
 *     intervalMs: 30_000,
 *     fetch: async (signal) => {
 *       const res = await fetch("https://flags.example.com/snapshot", { signal });
 *       return await res.json() as Record<string, string>;
 *     },
 *   }),
 *   onChange(_old, _next, changedKeys) {
 *     log.warn("dynamic config updated", { changed: changedKeys });
 *   },
 * });
 * ```
 */
export async function defineDynamicConfig<S extends ConfigSchema>(
  schema: S,
  options: DefineDynamicConfigOptions<S>,
): Promise<DynamicConfigHandle<S>> {
  const provider = options.provider;
  const propagate = options.propagateProviderErrors === true;
  const logger = options.logger;

  // Step 1 — initial fetch. A throw here is fatal regardless of
  // `propagate`; without an initial snapshot there is no valid view
  // to expose.
  let initialSnapshot: DynamicConfigSnapshot;
  try {
    initialSnapshot = await provider.get();
  } catch (err) {
    throw new ConfigProviderError(
      `Dynamic config provider '${provider.name}' failed to load initial snapshot.`,
      { cause: err, provider: provider.name, phase: "initial-load" },
    );
  }

  // Step 2 — validate the initial snapshot.
  const initial = validateSnapshot(schema, (entry) => initialSnapshot[entry.path]);
  if (initial.issues.length > 0) {
    throw new ConfigValidationError(
      `Forge dynamic configuration invalid (provider '${provider.name}') — ${initial.issues.length} issue(s).`,
      { issues: initial.issues },
    );
  }

  // Step 3 — freeze, ref-cell, proxy. The frozen tree is the
  // canonical "current" snapshot; the proxy reads through to it
  // forever (the ref is swapped, not the proxy).
  const ref: SnapshotRef<Infer<S>> = { current: deepFreeze(initial.tree) };
  const values = createSnapshotProxy(ref);

  // Step 4 — subscribe. Provider failures from this point on flow
  // through the logger unless `propagateProviderErrors: true`, in
  // which case the next `flush()`/`shutdown()` re-throws the
  // first-seen `ConfigProviderError`.
  let deferredError: ConfigProviderError | undefined;

  const recordError = (
    phase: "update" | "on-change" | "subscribe" | "shutdown" | "flush",
    err: unknown,
  ): void => {
    if (propagate && deferredError === undefined) {
      deferredError = new ConfigProviderError(
        `Dynamic config provider '${provider.name}' failed during ${phase}.`,
        { cause: err, provider: provider.name, phase },
      );
    }
    if (logger !== undefined) {
      emitProviderError(logger, {
        provider: provider.name,
        phase,
        error: err,
      });
    }
  };

  const onSnapshot = (next: DynamicConfigSnapshot): void => {
    const startedAt = performance.now();
    const result = validateSnapshot(schema, (entry) => next[entry.path]);
    if (result.issues.length > 0) {
      const err = new ConfigValidationError(
        `Forge dynamic configuration update invalid (provider '${provider.name}') — ${result.issues.length} issue(s).`,
        { issues: result.issues },
      );
      // Invalid updates do not poison the live view — we keep the
      // previously-valid snapshot and surface the error.
      recordError("update", err);
      return;
    }

    const previous = ref.current;
    const changedKeys = diff(previous, result.tree);
    if (changedKeys.length === 0) {
      // Nothing actually changed — skip the swap, skip the callbacks.
      // Providers that emit duplicates (a common polling-loop pattern)
      // do not produce phantom `onChange` calls.
      return;
    }

    ref.current = deepFreeze(result.tree);

    if (options.onChange !== undefined) {
      try {
        options.onChange(previous, ref.current, changedKeys);
      } catch (err) {
        recordError("on-change", err);
      }
    }

    if (logger !== undefined) {
      emitDynamicUpdate(logger, {
        provider: provider.name,
        updateTimeMs: Math.round(performance.now() - startedAt),
        changedKeys,
      });
    }
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = provider.subscribe(onSnapshot);
  } catch (err) {
    // A subscribe failure leaves us with a valid initial snapshot
    // but no future updates. That's still a usable boot: surface
    // the error via the logger (or defer for re-throw) and return
    // the handle.
    unsubscribe = () => {};
    recordError("subscribe", err);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      if (deferredError !== undefined) throw deferredError;
      return;
    }
    shuttingDown = true;
    try {
      unsubscribe();
    } catch (err) {
      // Unsubscribe is part of the shutdown lifecycle, so its
      // failures carry the `"shutdown"` phase label.
      recordError("shutdown", err);
    }
    if (provider.shutdown !== undefined) {
      try {
        await provider.shutdown();
      } catch (err) {
        recordError("shutdown", err);
      }
    }
    if (deferredError !== undefined) throw deferredError;
  };

  const flush = async (): Promise<void> => {
    if (provider.flush !== undefined) {
      try {
        await provider.flush();
      } catch (err) {
        recordError("flush", err);
      }
    }
    if (deferredError !== undefined) throw deferredError;
  };

  return {
    values,
    flush,
    shutdown,
    [Symbol.asyncDispose]: shutdown,
  };
}
