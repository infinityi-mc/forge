/**
 * `pollingProvider` — generic poll-on-an-interval dynamic provider.
 *
 * Consumers wrap this with their own `fetch` to integrate with
 * LaunchDarkly, AWS AppConfig, a DB row, an internal feature-flag
 * service, etc. The library intentionally does **not** ship a
 * concrete LaunchDarkly / SSM / Vault provider — those belong to the
 * application layer, where credential handling and SDK choice are
 * already decided.
 *
 * @module
 */

import type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
} from "./types";

export interface PollingProviderOptions {
  /**
   * Stable identifier surfaced in diagnostics and the dynamic-update
   * log. Required so multi-provider deployments can tell which feed
   * fired which update.
   */
  name: string;
  /**
   * The actual fetch — called once when `defineDynamicConfig` seeds
   * the initial snapshot, and once per `intervalMs` afterwards. The
   * `signal` parameter is the polling provider's lifecycle signal —
   * pass it through to `fetch()` / your SDK call so cancellation
   * propagates cleanly during shutdown.
   */
  fetch: (signal: AbortSignal) => Promise<DynamicConfigSnapshot>;
  /**
   * Interval between successive `fetch` calls, in milliseconds.
   * Counted from the end of one call to the start of the next — slow
   * fetches do not pile up.
   */
  intervalMs: number;
  /**
   * External abort signal. When supplied, aborting it stops the
   * polling loop in addition to the internal `shutdown()`. Useful
   * for tying the provider's lifetime to a larger graceful-shutdown
   * controller (e.g. an HTTP server's `signal`).
   */
  signal?: AbortSignal;
  /**
   * Invoked when `fetch` throws. The provider keeps polling on the
   * next tick regardless — transient failures (network blips, SDK
   * 5xx) should not permanently disable a feed. When omitted, errors
   * are swallowed silently; supply this to surface them via your
   * logger or metrics.
   */
  onError?: (err: unknown) => void;
}

/**
 * Build a generic polling provider. Subscribers receive every
 * successful fetch result — deduplication against the previous
 * snapshot happens inside `defineDynamicConfig` (where it can
 * compare typed values, not raw strings).
 */
export function pollingProvider(
  options: PollingProviderOptions,
): DynamicConfigProvider {
  if (
    typeof options.intervalMs !== "number" ||
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs <= 0
  ) {
    throw new RangeError(
      `pollingProvider: intervalMs must be a positive finite number, got ${String(options.intervalMs)}.`,
    );
  }

  const handlers = new Set<DynamicSnapshotHandler>();
  const controller = new AbortController();

  // If the caller supplied an external signal, abort our controller
  // as soon as theirs aborts.
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let started = false;

  const scheduleNext = (): void => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      void poll();
    }, options.intervalMs);
  };

  const poll = async (): Promise<void> => {
    if (controller.signal.aborted) return;
    if (polling) return; // never re-enter
    polling = true;
    try {
      const next = await options.fetch(controller.signal);
      if (controller.signal.aborted) return;
      for (const handler of handlers) {
        try {
          handler(next);
        } catch (err) {
          // Handler errors are surfaced via onError; they never
          // crash the polling loop.
          options.onError?.(err);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        options.onError?.(err);
      }
    } finally {
      polling = false;
      scheduleNext();
    }
  };

  return {
    name: options.name,

    async get(): Promise<DynamicConfigSnapshot> {
      return options.fetch(controller.signal);
    },

    subscribe(handler: DynamicSnapshotHandler): () => void {
      handlers.add(handler);
      if (!started) {
        started = true;
        scheduleNext();
      }
      return () => {
        handlers.delete(handler);
      };
    },

    async shutdown(): Promise<void> {
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      handlers.clear();
    },
  };
}
