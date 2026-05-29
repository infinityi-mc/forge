/**
 * Idempotency stores for `forge/messaging` — the dedup half of
 * "effective exactly-once" (at-least-once delivery + idempotent
 * consumption).
 *
 * `inMemoryInboxStore` is the default test double; `sqliteInboxStore`
 * (see `./sqlite`) adds durability. Both implement {@link InboxStore}:
 * `begin` claims a key, `commit` marks it done, `release` frees the
 * claim for reprocessing.
 *
 * @module
 */

import type { Clock, InboxState, InboxStore } from "../types";

export { sqliteInboxStore } from "./sqlite";
export type { SqliteInboxStoreOptions } from "./sqlite";

/** Options for {@link inMemoryInboxStore}. */
export interface InMemoryInboxStoreOptions {
  /** Clock used to expire `in-flight` claims. Defaults to the system clock. */
  readonly clock?: Clock;
}

interface Claim {
  state: "in-flight" | "done";
  /** Epoch ms after which an `in-flight` claim may be reclaimed; `undefined` = never. */
  expiresAt?: number;
}

/**
 * An in-process {@link InboxStore}. Suitable for single-process dedup
 * and as the default test double; use {@link sqliteInboxStore} when
 * claims must survive a restart.
 */
export function inMemoryInboxStore(
  options: InMemoryInboxStoreOptions = {},
): InboxStore {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const claims = new Map<string, Claim>();

  return {
    async begin(key: string, opts?: { ttlMs?: number }): Promise<InboxState> {
      const existing = claims.get(key);
      if (existing !== undefined) {
        if (existing.state === "done") return "duplicate";
        const expired =
          existing.expiresAt !== undefined && clock.now() > existing.expiresAt;
        if (!expired) return "in-flight";
        // Stale claim from a crashed worker: reclaim it.
      }
      claims.set(key, {
        state: "in-flight",
        expiresAt:
          opts?.ttlMs !== undefined ? clock.now() + opts.ttlMs : undefined,
      });
      return "new";
    },

    async commit(key: string): Promise<void> {
      claims.set(key, { state: "done" });
    },

    async release(key: string): Promise<void> {
      claims.delete(key);
    },
  };
}
