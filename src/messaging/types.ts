/**
 * Core public types for `forge/messaging`.
 *
 * The module is built on a few small contracts so each piece is
 * independently testable and swappable:
 *
 * - {@link Message} / {@link PublishMessage} — the transport-agnostic
 *   envelope that travels through the bus.
 * - {@link MessageBus} — the publish side.
 * - {@link Transport} — the broker adapter (bring your own).
 * - {@link MessageConsumer} / {@link MessageHandler} — the consume side.
 * - {@link Codec} — payload (de)serialization (default JSON).
 *
 * Observability (`meter` / `tracer` / `logger`) is **opt-in and
 * structurally typed**: `forge/messaging` never imports
 * `forge/telemetry`. Any object with the right method shapes — including
 * the handles produced by `forge/telemetry` — satisfies the contract.
 *
 * @module
 */

import type { Codec } from "./codec";

/**
 * A message as it travels through the bus — transport-agnostic and
 * already decoded by a {@link Codec}.
 */
export interface Message<T = unknown> {
  /** Stable, unique id. Used as the default idempotency key (PR B). */
  readonly id: string;
  /** Routing key / event name, e.g. `"order.placed"`. */
  readonly type: string;
  /** The domain payload, decoded from the wire body. */
  readonly payload: T;
  /** Free-form headers: tenant, content-type, trace context, etc. */
  readonly headers: Readonly<Record<string, string>>;
  /** When the producer created the message. */
  readonly occurredAt: Date;
  /** Redelivery count as reported by the transport (0 on first try). */
  readonly attempt: number;
}

/**
 * What a producer hands to {@link MessageBus.publish}. The bus fills in
 * the `id`, merges default headers, and stamps `occurredAt` when the
 * caller omits them.
 */
export interface PublishMessage<T = unknown> {
  /** Routing key / event name. */
  readonly type: string;
  /** The domain payload. */
  readonly payload: T;
  /** Explicit id. Defaults to a generated UUID. */
  readonly id?: string;
  /** Per-message headers, merged over the bus's `defaultHeaders`. */
  readonly headers?: Record<string, string>;
  /** Explicit creation time. Defaults to `new Date()`. */
  readonly occurredAt?: Date;
}

/**
 * The publish side of the module. Producers depend on this interface,
 * never on a concrete transport, so tests can inject
 * `InMemoryMessageBus`.
 */
export interface MessageBus {
  /** Publish one message. Resolves once the transport has accepted it. */
  publish<T>(message: PublishMessage<T>): Promise<void>;
  /** Publish a batch; sent in one `transport.send` call. */
  publishBatch(messages: readonly PublishMessage[]): Promise<void>;
  /** Drain any in-flight publishes (no-op for non-batching transports). */
  flush(): Promise<void>;
  /** Release transport resources. */
  shutdown(): Promise<void>;
}

/** Options for {@link createMessageBus}. */
export interface MessageBusOptions {
  /** The broker adapter messages are sent through. */
  readonly transport: Transport;
  /** Payload (de)serialization. Defaults to {@link jsonCodec}. */
  readonly codec?: Codec;
  /** Headers merged under every published message's own headers. */
  readonly defaultHeaders?: Record<string, string>;
  /** Opt-in metrics + traces. */
  readonly telemetry?: MessagingTelemetry;
  /** Opt-in structured logging. */
  readonly logger?: Logger;
  /** Id factory for messages without an explicit id. Default: `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
}

/**
 * A single record on the wire. Transports are dumb byte pipes: the bus
 * encodes the envelope into a record and the consumer decodes it back
 * into a {@link Message}. Envelope metadata that has no first-class
 * field (currently just `occurredAt`) travels as a reserved header.
 */
export interface TransportRecord {
  /** Routing key / event name. */
  readonly type: string;
  /** Stable message id. */
  readonly id: string;
  /** Headers (user headers + reserved `x-forge-*` envelope metadata). */
  readonly headers: Record<string, string>;
  /** The encoded payload. */
  readonly body: Uint8Array;
}

/**
 * A delivery handed to a subscription. The consumer must call exactly
 * one of {@link ack} / {@link nack}; failing to call either before
 * returning is treated as a {@link nack} (at-least-once).
 */
export interface TransportDelivery {
  /** The record being delivered. */
  readonly record: TransportRecord;
  /** Redelivery count (0 on first delivery). */
  readonly attempt: number;
  /** Acknowledge successful processing; the record will not be redelivered. */
  ack(): Promise<void> | void;
  /** Negatively acknowledge; the transport may redeliver the record. */
  nack(): Promise<void> | void;
}

/**
 * A subscription request handed to {@link Transport.subscribe}. The
 * transport pushes deliveries to {@link onMessage}, dispatching up to
 * {@link concurrency} at a time (prefetch).
 */
export interface TransportSubscription {
  /** Topic to receive from. Transports may support a `"*"` catch-all. */
  readonly topic: string;
  /** Max in-flight deliveries dispatched concurrently. Default 1. */
  readonly concurrency?: number;
  /** Per-delivery callback. */
  onMessage(delivery: TransportDelivery): Promise<void> | void;
}

/** Handle returned by {@link Transport.subscribe} to stop receiving. */
export interface TransportHandle {
  /** Stop dispatching and await in-flight deliveries to settle. */
  stop(): Promise<void>;
}

/**
 * The broker adapter. Built-in implementations: `inMemoryTransport`
 * (PR A); durable SQLite and Postgres transports follow in PR C. Bring
 * your own by implementing this interface — the
 * `STANDARD_MESSAGING_SCENARIOS` conformance suite verifies it stays
 * drop-in compatible.
 */
export interface Transport {
  /** Stable identifier, used in spans / logs / errors. */
  readonly name: string;
  /** Send one or more records. */
  send(records: readonly TransportRecord[]): Promise<void>;
  /** Begin receiving for a subscription. */
  subscribe(subscription: TransportSubscription): Promise<TransportHandle>;
  /** Release resources. */
  shutdown?(): Promise<void>;
}

/** Context passed to every {@link MessageHandler} invocation. */
export interface ConsumeContext {
  /** Aborted when the consumer stops; pass to cooperating I/O (`fetch`, db). */
  readonly signal: AbortSignal;
  /** Logger bound to the consumer (a no-op when none was injected). */
  readonly logger: Logger;
}

/** A user-supplied consume callback. */
export type MessageHandler<T = unknown> = (
  message: Message<T>,
  ctx: ConsumeContext,
) => Promise<void> | void;

/** A running consumer. Construct with {@link createConsumer}. */
export interface MessageConsumer {
  /** Subscribe and begin processing. */
  start(): Promise<void>;
  /** Stop pulling, abort the consume signal, and await in-flight handlers. */
  stop(): Promise<void>;
}

/**
 * Options for {@link createConsumer}.
 *
 * PR A delivers at-least-once consumption with bounded concurrency.
 * Idempotency (`inbox`), bounded retry, and dead-lettering arrive in
 * PR B.
 */
export interface ConsumerOptions {
  /** The broker adapter to receive from. */
  readonly transport: Transport;
  /** Topic to subscribe to. */
  readonly topic: string;
  /** The consume callback. */
  readonly handler: MessageHandler;
  /** Payload (de)serialization. Defaults to {@link jsonCodec}. */
  readonly codec?: Codec;
  /** Max in-flight handlers. Default 1. */
  readonly concurrency?: number;
  /** Opt-in metrics + traces. */
  readonly telemetry?: MessagingTelemetry;
  /** Opt-in structured logging. */
  readonly logger?: Logger;
}

/* -------------------------------------------------------------------------- */
/* Structural observability contracts (no hard `forge/telemetry` dependency)  */
/* -------------------------------------------------------------------------- */

/** Attribute bag attached to metrics, spans, and logs. */
export type Attributes = Record<string, string | number | boolean>;

/** A counter instrument — structurally compatible with `forge/telemetry`. */
export interface CounterLike {
  add(value: number, attributes?: Attributes): void;
}

/** A histogram instrument — structurally compatible with `forge/telemetry`. */
export interface HistogramLike {
  record(value: number, attributes?: Attributes): void;
}

/** The slice of a meter `forge/messaging` uses. */
export interface MeterLike {
  createCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): CounterLike;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): HistogramLike;
}

/** A span — structurally compatible with `forge/telemetry`. */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
  end(endTime?: Date): void;
}

/** The slice of a tracer `forge/messaging` uses. */
export interface TracerLike {
  startSpan(
    name: string,
    options?: {
      kind?: "internal" | "server" | "client" | "producer" | "consumer";
      attributes?: Attributes;
    },
  ): SpanLike;
}

/** Opt-in telemetry handles for the bus and consumers. */
export interface MessagingTelemetry {
  readonly meter?: MeterLike;
  readonly tracer?: TracerLike;
}

/** Structured-attribute bag accepted by {@link Logger} methods. */
export type LogAttributes = Readonly<Record<string, unknown>>;

/**
 * Minimum logger surface `forge/messaging` invokes. Structurally
 * compatible with `forge/telemetry/log` child loggers and `console`,
 * but deliberately not imported from either.
 */
export interface Logger {
  debug(msg: string, attrs?: LogAttributes): void;
  info(msg: string, attrs?: LogAttributes): void;
  warn(msg: string, attrs?: LogAttributes): void;
  error(msg: string, attrs?: LogAttributes): void;
}
