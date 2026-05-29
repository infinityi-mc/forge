/**
 * Shared redrive helper for the dead-letter stores. Kept in its own
 * module so the in-memory and SQLite stores can both use it without an
 * import cycle.
 *
 * @module
 */

import type { DeadLetterEntry, MessageBus } from "../types";

/** Re-publish a dead-lettered message back onto its source topic. */
export async function redrivePublish(
  entry: DeadLetterEntry,
  bus: MessageBus,
): Promise<void> {
  const { message } = entry;
  await bus.publish({
    type: message.type,
    payload: message.payload,
    id: message.id,
    headers: { ...message.headers },
    occurredAt: message.occurredAt,
  });
}
