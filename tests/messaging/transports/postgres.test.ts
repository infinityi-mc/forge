import { describe, expect, test } from "bun:test";
import {
  STANDARD_MESSAGING_SCENARIOS,
  assertConformance,
} from "../../../src/messaging/testing";
import { createConsumer, createMessageBus } from "../../../src/messaging";
import {
  postgresTransport,
  type PostgresClientLike,
  type PostgresQueryResult,
} from "../../../src/messaging/transports/postgres";
import { topicMatches } from "../../../src/messaging/topic";
import type { Message } from "../../../src/messaging";

interface Row {
  seq: number;
  type: string;
  msg_id: string;
  headers: string;
  body: string;
  attempt: number;
  visible_at: number;
}

/**
 * An in-memory fake that understands exactly the statements
 * `postgresTransport` issues: the migration, LISTEN/NOTIFY, INSERT, the
 * `FOR UPDATE SKIP LOCKED` claim CTE, DELETE, and the requeue UPDATE.
 * It lets the transport's claim/ack/nack control flow be exercised
 * without a live PostgreSQL server.
 */
class FakePostgresClient implements PostgresClientLike {
  private rows: Row[] = [];
  private seq = 0;
  private listeners = new Set<(message: unknown) => void>();

  async query<R = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<R>> {
    const text = sql.trim();

    if (text.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (text.startsWith("LISTEN")) return { rows: [], rowCount: 0 };
    if (text.startsWith("NOTIFY")) {
      for (const listener of this.listeners) queueMicrotask(() => listener({}));
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith("INSERT INTO")) {
      this.seq += 1;
      this.rows.push({
        seq: this.seq,
        type: params[0] as string,
        msg_id: params[1] as string,
        headers: params[2] as string,
        body: params[3] as string,
        attempt: 0,
        visible_at: 0,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      const now = params[0] as number;
      const topic = params[1] as string;
      const lockUntil = params[2] as number;
      const candidate = this.rows
        .filter((r) => r.visible_at <= now && topicMatches(topic, r.type))
        .sort((a, b) => a.seq - b.seq)[0];
      if (candidate === undefined) return { rows: [], rowCount: 0 };
      candidate.visible_at = lockUntil;
      return {
        rows: [{ ...candidate } as unknown as R],
        rowCount: 1,
      };
    }

    if (text.startsWith("DELETE FROM")) {
      const seq = params[0] as number;
      this.rows = this.rows.filter((r) => r.seq !== seq);
      return { rows: [], rowCount: 1 };
    }

    if (text.startsWith("UPDATE")) {
      const attempt = params[0] as number;
      const visibleAt = params[1] as number;
      const seq = params[2] as number;
      const row = this.rows.find((r) => r.seq === seq);
      if (row !== undefined) {
        row.attempt = attempt;
        row.visible_at = visibleAt;
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`FakePostgresClient: unhandled SQL: ${text}`);
  }

  on(_event: "notification", listener: (message: unknown) => void): void {
    this.listeners.add(listener);
  }

  removeListener(
    _event: "notification",
    listener: (message: unknown) => void,
  ): void {
    this.listeners.delete(listener);
  }

  get size(): number {
    return this.rows.length;
  }
}

describe("postgresTransport conformance (fake client)", () => {
  test("satisfies the standard messaging scenarios", async () => {
    await assertConformance(
      () =>
        postgresTransport({
          client: new FakePostgresClient(),
          pollIntervalMs: 5,
        }),
      STANDARD_MESSAGING_SCENARIOS,
    );
  });

  for (const scenario of STANDARD_MESSAGING_SCENARIOS) {
    test(scenario.name, async () => {
      await scenario.run(() =>
        postgresTransport({
          client: new FakePostgresClient(),
          pollIntervalMs: 5,
        }),
      );
    });
  }
});

describe("postgresTransport behavior", () => {
  test("claims each record once across concurrent subscriptions", async () => {
    const client = new FakePostgresClient();
    const transport = postgresTransport({ client, pollIntervalMs: 2 });
    const bus = createMessageBus({ transport });
    const received: Message[] = [];
    const consumer = createConsumer({
      transport,
      topic: "work",
      concurrency: 4,
      handler: (msg) => {
        received.push(msg);
      },
    });
    await consumer.start();
    for (let i = 0; i < 20; i += 1) {
      await bus.publish({ type: "work", payload: { i }, id: `w${i}` });
    }
    const deadline = Date.now() + 2000;
    while (received.length < 20 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await consumer.stop();

    expect(received).toHaveLength(20);
    const ids = new Set(received.map((m) => m.id));
    expect(ids.size).toBe(20); // no record delivered twice
    expect(client.size).toBe(0); // all acked

    await transport.shutdown();
  });

  test("rejects an unsafe table name and channel", () => {
    expect(() =>
      postgresTransport({
        client: new FakePostgresClient(),
        table: "msgs; drop table x",
      }),
    ).toThrow();
    expect(() =>
      postgresTransport({
        client: new FakePostgresClient(),
        channel: "bad channel",
      }),
    ).toThrow();
  });
});
