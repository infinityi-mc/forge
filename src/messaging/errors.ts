/**
 * Typed error taxonomy for `forge/messaging`.
 *
 * Every error the module throws is a subclass of {@link MessagingError},
 * so consumers can branch with a single `instanceof MessagingError`
 * check or narrow to a specific category.
 *
 * PR A ships the errors reachable from the publish / consume path
 * ({@link TransportError}, {@link SerializationError},
 * {@link HandlerError}). PR B adds {@link MessageDroppedError} and
 * {@link IdempotencyError}; PR C adds {@link OutboxRelayError} and
 * {@link JobError} for the outbox relay and background-job surfaces.
 *
 * @module
 */

/**
 * Base class for every error thrown by `forge/messaging`. Use this when
 * no more specific category fits, or when an `instanceof MessagingError`
 * check should catch the whole family.
 */
export class MessagingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MessagingError";
  }
}

/**
 * A transport-level failure: the broker rejected a `send`, a
 * subscription could not be established, or a delivery could not be
 * acknowledged.
 */
export class TransportError extends MessagingError {
  /** The transport that raised the failure, when known. */
  readonly transport?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { transport?: string },
  ) {
    super(message, options);
    this.name = "TransportError";
    if (options?.transport !== undefined) {
      this.transport = options.transport;
    }
  }
}

/** A payload could not be encoded or decoded by the active {@link Codec}. */
export class SerializationError extends MessagingError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SerializationError";
  }
}

/**
 * Wraps an error thrown by a user-supplied {@link MessageHandler}. The
 * original error is preserved on `cause`. In PR A a handler failure
 * causes the delivery to be nacked (at-least-once redelivery); bounded
 * retry and dead-lettering follow in PR B.
 */
export class HandlerError extends MessagingError {
  /** The message type whose handler threw. */
  readonly messageType?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { messageType?: string },
  ) {
    super(message, options);
    this.name = "HandlerError";
    if (options?.messageType !== undefined) {
      this.messageType = options.messageType;
    }
  }
}

/**
 * A message exhausted its bounded retries and was routed to the
 * dead-letter store. Raised internally on the consume path; the
 * originating handler failure is preserved on `cause`. It is recorded
 * and dead-lettered, never surfaced to the caller of `publish`.
 */
export class MessageDroppedError extends MessagingError {
  /** The id of the dropped message. */
  readonly messageId?: string;
  /** How many handler attempts were made before giving up. */
  readonly attempts?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { messageId?: string; attempts?: number },
  ) {
    super(message, options);
    this.name = "MessageDroppedError";
    if (options?.messageId !== undefined) this.messageId = options.messageId;
    if (options?.attempts !== undefined) this.attempts = options.attempts;
  }
}

/**
 * An idempotency / inbox store reported an inconsistent state — for
 * example a `commit`/`release` for a key that was never claimed, or a
 * backing-store failure during dedup.
 */
export class IdempotencyError extends MessagingError {
  /** The idempotency key involved, when known. */
  readonly key?: string;

  constructor(message: string, options?: ErrorOptions & { key?: string }) {
    super(message, options);
    this.name = "IdempotencyError";
    if (options?.key !== undefined) this.key = options.key;
  }
}

/**
 * The outbox relay failed to read its source table, publish a row, or
 * mark a row dispatched. The originating failure is preserved on
 * `cause`. The relay logs and retries on its next poll rather than
 * surfacing this to a caller.
 */
export class OutboxRelayError extends MessagingError {
  /** The outbox table involved, when known. */
  readonly table?: string;

  constructor(message: string, options?: ErrorOptions & { table?: string }) {
    super(message, options);
    this.name = "OutboxRelayError";
    if (options?.table !== undefined) this.table = options.table;
  }
}

/**
 * A background job failed to execute. Wraps the originating handler
 * throw on `cause`; the worker reuses the same retry → dead-letter
 * machinery as consumers, so an exhausted job is parked rather than
 * surfaced to the enqueuer.
 */
export class JobError extends MessagingError {
  /** The id of the job that failed, when known. */
  readonly jobId?: string;
  /** The job name / type, when known. */
  readonly jobName?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { jobId?: string; jobName?: string },
  ) {
    super(message, options);
    this.name = "JobError";
    if (options?.jobId !== undefined) this.jobId = options.jobId;
    if (options?.jobName !== undefined) this.jobName = options.jobName;
  }
}
