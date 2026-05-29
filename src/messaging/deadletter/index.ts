/**
 * Dead-letter stores for `forge/messaging`.
 *
 * When a message exhausts its bounded retries the consumer parks it in a
 * {@link DeadLetterStore} instead of blocking the topic forever. Operators
 * can later `list` the backlog, `redrive` a message back to its source
 * topic, or `remove` it.
 *
 * `inMemoryDeadLetterStore` is the default test double;
 * `sqliteDeadLetterStore` (see `./sqlite`) adds durability.
 *
 * @module
 */

import { MessagingError } from "../errors";
import type { DeadLetterEntry, DeadLetterStore, MessageBus } from "../types";
import { redrivePublish } from "./redrive";

export { sqliteDeadLetterStore } from "./sqlite";
export type { SqliteDeadLetterStoreOptions } from "./sqlite";

/**
 * An in-process {@link DeadLetterStore}, keyed by message id, preserving
 * insertion order. Doubles as the default test double.
 */
export function inMemoryDeadLetterStore(): DeadLetterStore {
  const entries = new Map<string, DeadLetterEntry>();

  return {
    async store(entry: DeadLetterEntry): Promise<void> {
      entries.set(entry.message.id, entry);
    },

    async list(opts?: { limit?: number }): Promise<readonly DeadLetterEntry[]> {
      // Newest first.
      const all = [...entries.values()].reverse();
      return opts?.limit !== undefined ? all.slice(0, opts.limit) : all;
    },

    async redrive(id: string, bus: MessageBus): Promise<void> {
      const entry = entries.get(id);
      if (entry === undefined) {
        throw new MessagingError(`No dead-letter entry for id "${id}"`);
      }
      await redrivePublish(entry, bus);
    },

    async remove(id: string): Promise<void> {
      entries.delete(id);
    },
  };
}
