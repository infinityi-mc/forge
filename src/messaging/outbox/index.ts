/**
 * Outbox relay entry point — `forge/messaging/outbox`.
 *
 * Re-exports {@link createOutboxRelay} and its types so the relay can be
 * imported behind its own subpath, mirroring `forge/messaging/inbox` and
 * `forge/messaging/deadletter`.
 *
 * @module
 */

export { createOutboxRelay } from "./relay";
export type {
  DbLike,
  OutboxQuery,
  OutboxQueryBuilder,
  OutboxQueryResult,
  OutboxRelay,
  OutboxRelayOptions,
} from "./types";
