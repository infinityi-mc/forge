import { describe, expect, test } from "bun:test";
import { createDb, sql } from "../../src/data";
import {
  createSqliteDialect,
  createSqliteDriver,
} from "../../src/data/dialects/sqlite";
import { createOutboxRelay } from "../../src/messaging/outbox";
import {
  InMemoryMessageBus,
  assertOutboxRelayConformance,
} from "../../src/messaging/testing";
import type { Attributes, MeterLike } from "../../src/messaging";

interface OutboxSchema {
  _forge_outbox: {
    id: number;
    type: string;
    payload: string;
    metadata: string;
    occurred_at: string;
  };
}

function createTestDb() {
  return createDb<OutboxSchema>({
    dialect: createSqliteDialect(),
    driver: createSqliteDriver(),
  });
}

async function createOutboxTable(db: ReturnType<typeof createTestDb>) {
  await db
    .raw(
      sql`
        create table _forge_outbox (
          id integer primary key autoincrement,
          type text not null,
          payload text not null,
          metadata text not null,
          occurred_at text not null
        )
      `,
    )
    .execute();
}

function recordingMeter(): {
  meter: MeterLike;
  samples: Array<{ name: string; value: number; attributes?: Attributes }>;
} {
  const samples: Array<{
    name: string;
    value: number;
    attributes?: Attributes;
  }> = [];
  const meter: MeterLike = {
    createCounter(name) {
      return {
        add(value, attributes) {
          samples.push({ name, value, attributes });
        },
      };
    },
    createHistogram(name) {
      return {
        record(value, attributes) {
          samples.push({ name, value, attributes });
        },
      };
    },
    createUpDownCounter(name) {
      return {
        add(value, attributes) {
          samples.push({ name, value, attributes });
        },
      };
    },
  };
  return { meter, samples };
}

describe("createOutboxRelay", () => {
  test("forwards pending outbox rows to the bus and marks them dispatched", async () => {
    const db = createTestDb();
    await createOutboxTable(db);

    await db.uow(async (tx) => {
      await tx.outbox.publish("order.placed", { orderId: "1" });
      await tx.outbox.publish("order.placed", { orderId: "2" });
    });

    const bus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus });

    const count = await relay.drainOnce();
    expect(count).toBe(2);
    expect(bus.publishedEvents).toEqual([
      { type: "order.placed", payload: { orderId: "1" } },
      { type: "order.placed", payload: { orderId: "2" } },
    ]);

    await db.shutdown();
  });

  test("does not re-publish a row that was already dispatched", async () => {
    const db = createTestDb();
    await createOutboxTable(db);
    await db.uow(async (tx) => {
      await tx.outbox.publish("user.created", { id: 7 });
    });

    const bus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus });

    expect(await relay.drainOnce()).toBe(1);
    expect(await relay.drainOnce()).toBe(0);
    expect(bus.messages).toHaveLength(1);

    await db.shutdown();
  });

  test("preserves occurredAt, a stable id, and metadata headers", async () => {
    const db = createTestDb();
    await createOutboxTable(db);
    await db.uow(async (tx) => {
      await tx.outbox.publish(
        "order.placed",
        { orderId: "42" },
        {
          metadata: { tenant: "acme", traceId: "abc", attempt: 3 },
          occurredAt: new Date("2026-01-02T03:04:05.000Z"),
        },
      );
    });

    const bus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus });
    await relay.drainOnce();

    const message = bus.messages[0];
    expect(message?.id).toBe("1");
    expect(message?.occurredAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(message?.headers.tenant).toBe("acme");
    expect(message?.headers.traceId).toBe("abc");
    // Non-string metadata is JSON-encoded into the string header bag.
    expect(message?.headers.attempt).toBe("3");

    await db.shutdown();
  });

  test("re-publishes an undispatched row after a crash (at-least-once)", async () => {
    const db = createTestDb();
    await createOutboxTable(db);
    await db.uow(async (tx) => {
      await tx.outbox.publish("payment.captured", { id: "p1" });
    });

    // First relay publishes but we simulate a crash *before* it could
    // mark the row dispatched by rolling the dispatch flag back.
    const failingBus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus: failingBus });
    await relay.drainOnce();
    await db
      .raw(sql`update _forge_outbox set dispatched_at = null`)
      .execute();

    // A fresh relay re-publishes the still-pending row.
    const bus = new InMemoryMessageBus();
    const recovered = createOutboxRelay({ db, bus });
    expect(await recovered.drainOnce()).toBe(1);
    expect(bus.messages).toHaveLength(1);

    await db.shutdown();
  });

  test("reports backlog through messaging.outbox.pending", async () => {
    const db = createTestDb();
    await createOutboxTable(db);
    await db.uow(async (tx) => {
      await tx.outbox.publish("a", {});
      await tx.outbox.publish("b", {});
    });

    const { meter, samples } = recordingMeter();
    const bus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus, telemetry: { meter } });
    await relay.drainOnce();

    const pending = samples.filter((s) => s.name === "messaging.outbox.pending");
    // Backlog drains to zero after dispatch.
    expect(pending.at(-1)?.value).toBe(0);
    const dispatched = samples.filter(
      (s) => s.name === "messaging.outbox.dispatched",
    );
    expect(dispatched).toHaveLength(2);

    await db.shutdown();
  });

  test("satisfies the standard outbox-relay conformance scenarios", async () => {
    await assertOutboxRelayConformance(async () => {
      const db = createTestDb();
      await createOutboxTable(db);
      return {
        db,
        async insert(row) {
          await db
            .raw(
              sql`insert into _forge_outbox (type, payload, metadata, occurred_at)
                  values (${row.type}, ${row.payload}, ${row.metadata}, ${row.occurredAt})`,
            )
            .execute();
        },
      };
    });
  });

  test("start/stop drains in the background", async () => {
    const db = createTestDb();
    await createOutboxTable(db);
    await db.uow(async (tx) => {
      await tx.outbox.publish("bg.event", { n: 1 });
    });

    const bus = new InMemoryMessageBus();
    const relay = createOutboxRelay({ db, bus, pollIntervalMs: 5 });
    await relay.start();

    const deadline = Date.now() + 1000;
    while (bus.messages.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await relay.stop();

    expect(bus.messages).toHaveLength(1);
    await db.shutdown();
  });
});
