import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as messaging from "../../src/messaging";
import * as inbox from "../../src/messaging/inbox";
import * as deadletter from "../../src/messaging/deadletter";
import * as outbox from "../../src/messaging/outbox";
import * as jobs from "../../src/messaging/jobs";
import * as sqliteTransport from "../../src/messaging/transports/sqlite";
import * as postgresTransport from "../../src/messaging/transports/postgres";

describe("messaging exports", () => {
  test("messaging symbols stay scoped to forge/messaging rather than the package root", () => {
    expect(messaging.createMessageBus).toBeFunction();
    expect(messaging.createConsumer).toBeFunction();
    expect(messaging.jsonCodec).toBeFunction();
    expect("createMessageBus" in root).toBe(false);
  });

  test("error taxonomy is exported", () => {
    expect(new messaging.TransportError("x")).toBeInstanceOf(messaging.MessagingError);
    expect(new messaging.SerializationError("x")).toBeInstanceOf(
      messaging.MessagingError,
    );
    expect(new messaging.HandlerError("x")).toBeInstanceOf(messaging.MessagingError);
    expect(new messaging.MessageDroppedError("x")).toBeInstanceOf(
      messaging.MessagingError,
    );
    expect(new messaging.IdempotencyError("x")).toBeInstanceOf(
      messaging.MessagingError,
    );
    expect(new messaging.OutboxRelayError("x")).toBeInstanceOf(
      messaging.MessagingError,
    );
    expect(new messaging.JobError("x")).toBeInstanceOf(messaging.MessagingError);
  });

  test("inbox and dead-letter stores are exported behind their own entrypoints", () => {
    expect(inbox.inMemoryInboxStore).toBeFunction();
    expect(inbox.sqliteInboxStore).toBeFunction();
    expect(deadletter.inMemoryDeadLetterStore).toBeFunction();
    expect(deadletter.sqliteDeadLetterStore).toBeFunction();
  });

  test("PR C surfaces are exported behind their own entrypoints", () => {
    expect(outbox.createOutboxRelay).toBeFunction();
    expect(jobs.createJobQueue).toBeFunction();
    expect(jobs.createWorker).toBeFunction();
    expect(jobs.inMemoryJobStore).toBeFunction();
    expect(jobs.sqliteJobStore).toBeFunction();
    expect(sqliteTransport.sqliteTransport).toBeFunction();
    expect(postgresTransport.postgresTransport).toBeFunction();
  });
});
