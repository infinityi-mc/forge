/**
 * Types for the outbox relay — the bridge from `forge/data`'s
 * transactional outbox to a {@link MessageBus}.
 *
 * The relay depends on a **structural** slice of `forge/data`'s `Db`
 * ({@link DbLike}) rather than importing `forge/data`, mirroring how the
 * rest of `forge/messaging` consumes `forge/resilience` and
 * `forge/telemetry`. A real `Db` is drop-in assignable to {@link DbLike}.
 *
 * @module
 */

import type {
  Clock,
  Logger,
  MessageBus,
  MessagingTelemetry,
  RetryPolicyLike,
} from "../types";

/**
 * A parameterized query, using `?` placeholders. `forge/data` rewrites
 * `?` to the active dialect's placeholder (`$1`, … for Postgres), so the
 * relay stays dialect-agnostic.
 */
export interface OutboxQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The result of executing an {@link OutboxQuery}. */
export interface OutboxQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly numAffectedRows: bigint;
}

/** A builder returned by {@link DbLike.raw}; only `execute` is used. */
export interface OutboxQueryBuilder<Row> {
  execute(): Promise<OutboxQueryResult<Row>>;
}

/**
 * The minimal structural slice of `forge/data`'s `Db` the relay needs:
 * the dialect's identifier quoting and a `raw` escape hatch. A concrete
 * `Db<Schema>` satisfies this without any import of `forge/data`.
 */
export interface DbLike {
  readonly dialect: {
    quoteIdentifier(identifier: string): string;
  };
  raw<Row = unknown>(query: OutboxQuery): OutboxQueryBuilder<Row>;
}

/** Options for {@link createOutboxRelay}. */
export interface OutboxRelayOptions {
  /** Structural slice of a `forge/data` `Db` reading the outbox table. */
  readonly db: DbLike;
  /** The bus pending rows are forwarded to. */
  readonly bus: MessageBus;
  /** Outbox table name. Defaults to `"_forge_outbox"` (matches `forge/data`). */
  readonly table?: string;
  /** Max rows processed per poll. Default 100. */
  readonly batchSize?: number;
  /** Delay between polls once a batch is empty, in ms. Default 1000. */
  readonly pollIntervalMs?: number;
  /**
   * Reserved for per-key FIFO ordering. Unordered at-least-once is the
   * default; ordered relay is deferred to a follow-up. Default false.
   */
  readonly ordered?: boolean;
  /**
   * Bounded retry around each row's publish, consumed structurally from
   * `forge/resilience`. On exhaustion the row is left pending (its
   * `attempts` incremented) for a later poll.
   */
  readonly retry?: RetryPolicyLike;
  /** Opt-in metrics + traces. */
  readonly telemetry?: MessagingTelemetry;
  /** Opt-in structured logging. */
  readonly logger?: Logger;
  /** Injectable clock for timestamps and backoff. Defaults to system time. */
  readonly clock?: Clock;
}

/**
 * Relays rows written by `forge/data`'s `tx.outbox.publish(...)` to a
 * {@link MessageBus}, marking them dispatched. At-least-once: a crash
 * between publish and mark-dispatched re-publishes on the next poll.
 */
export interface OutboxRelay {
  /** Begin polling the outbox in the background. */
  start(): Promise<void>;
  /** Stop polling and await the in-flight drain. */
  stop(): Promise<void>;
  /** Process the currently pending batch once; resolves with the count. */
  drainOnce(): Promise<number>;
}
