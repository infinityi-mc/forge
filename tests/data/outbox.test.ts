import { describe, expect, test } from "bun:test";
import { createDb, sql } from "../../src/data";
import { createSqliteDialect, createSqliteDriver } from "../../src/data/dialects/sqlite";

interface TestDb {
  _forge_outbox: {
    id: number;
    type: string;
    payload: string;
    metadata: string;
    occurred_at: string;
  };
}

function createTestDb() {
  return createDb<TestDb>({
    dialect: createSqliteDialect(),
    driver: createSqliteDriver(),
  });
}

async function createOutboxTable(db: ReturnType<typeof createTestDb>) {
  await db.raw(sql`
    create table _forge_outbox (
      id integer primary key autoincrement,
      type text not null,
      payload text not null,
      metadata text not null,
      occurred_at text not null
    )
  `).execute();
}

describe("transaction outbox", () => {
  test("publishes messages inside the transaction", async () => {
    const db = createTestDb();
    await createOutboxTable(db);

    await db.uow(async (tx) => {
      await tx.outbox.publish("user.created", { id: 1 }, {
        metadata: { traceId: "abc" },
        occurredAt: new Date("2026-01-02T03:04:05.000Z"),
      });
    });

    const row = await db
      .selectFrom("_forge_outbox")
      .select(["type", "payload", "metadata", "occurred_at"] as const)
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      type: "user.created",
      payload: "{\"id\":1}",
      metadata: "{\"traceId\":\"abc\"}",
      occurred_at: "2026-01-02T03:04:05.000Z",
    });

    await db.shutdown();
  });

  test("rolls outbox rows back with the transaction", async () => {
    const db = createTestDb();
    await createOutboxTable(db);

    await expect(db.uow(async (tx) => {
      await tx.outbox.publish("user.created", { id: 1 });
      throw new Error("abort");
    })).rejects.toThrow("abort");

    const rows = await db.selectFrom("_forge_outbox").execute();
    expect(rows.rows).toEqual([]);

    await db.shutdown();
  });
});
