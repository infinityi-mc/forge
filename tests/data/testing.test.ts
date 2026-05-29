import { describe, expect, test } from "bun:test";
import { createDb, sql } from "../../src/data";
import { createSqliteDialect, createSqliteDriver } from "../../src/data/dialects/sqlite";
import {
  assertDriverConformance,
  createSqliteTestDb,
  recordingDriver,
  withRollbackTest,
} from "../../src/data/testing";

interface TestDb {
  users: {
    id: number;
    email: string;
  };
}

describe("data testing helpers", () => {
  test("recordingDriver captures compiled queries", async () => {
    const driver = recordingDriver();
    const db = createDb<TestDb>({
      dialect: createSqliteDialect(),
      driver,
    });

    await db.raw(sql`select ${1}`).execute();

    expect(driver.queries).toHaveLength(1);
    expect(driver.queries[0]).toMatchObject({ sql: "select ?", params: [1] });
  });

  test("withRollbackTest rolls back successful callback writes", async () => {
    const db = createSqliteTestDb<TestDb>();
    await db.raw(sql`create table users (id integer primary key, email text not null)`).execute();

    await withRollbackTest(db, async (tx) => {
      await tx.raw(sql`insert into users (email) values (${"a@example.com"})`).execute();
    });

    const rows = await db.raw(sql`select * from users`).execute();
    expect(rows.rows).toEqual([]);
    await db.shutdown();
  });

  test("driver conformance scenarios run against SQLite", async () => {
    await assertDriverConformance({
      createDriver: () => createSqliteDriver(),
      createDb: () => createSqliteTestDb(),
    });
  });
});
