import { describe, expect, test } from "bun:test";
import { createDb, sql, type CompiledQuery, type Driver, type QueryResult } from "../../src/data";
import { createSqliteDialect } from "../../src/data/dialects/sqlite";

interface TestDb {
  users: {
    id: number;
    email: string;
  };
}

function createRecordingDb() {
  const queries: string[] = [];
  const driver: Driver = {
    name: "recording",
    execute<Row = unknown>(query: CompiledQuery): QueryResult<Row> {
      queries.push(query.sql);
      return { rows: [], numAffectedRows: 0n };
    },
  };
  const db = createDb<TestDb>({ dialect: createSqliteDialect(), driver });
  return { db, queries };
}

function createFailingRollbackDb() {
  const queries: string[] = [];
  const driver: Driver = {
    name: "recording",
    execute<Row = unknown>(query: CompiledQuery): QueryResult<Row> {
      queries.push(query.sql);
      if (query.sql === "rollback to savepoint forge_sp_1") {
        throw new Error("rollback failed");
      }
      return { rows: [], numAffectedRows: 0n };
    },
  };
  const db = createDb<TestDb>({ dialect: createSqliteDialect(), driver });
  return { db, queries };
}

describe("unit of work", () => {
  test("commits successful work", async () => {
    const { db, queries } = createRecordingDb();

    await db.uow(async (tx) => {
      await tx.raw(sql`select 1`).execute();
    });

    expect(queries).toEqual(["begin", "select 1", "commit"]);
  });

  test("rolls back failed work", async () => {
    const { db, queries } = createRecordingDb();

    await expect(db.uow(async (tx) => {
      await tx.raw(sql`select 1`).execute();
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(queries).toEqual(["begin", "select 1", "rollback"]);
  });

  test("uses savepoints for nested work", async () => {
    const { db, queries } = createRecordingDb();

    await db.uow(async (tx) => {
      await tx.uow(async (nested) => {
        await nested.raw(sql`select 1`).execute();
      });
    });

    expect(queries).toEqual([
      "begin",
      "savepoint forge_sp_1",
      "select 1",
      "release savepoint forge_sp_1",
      "commit",
    ]);
  });

  test("rolls back to the current savepoint for nested failures", async () => {
    const { db, queries } = createRecordingDb();

    await db.uow(async (tx) => {
      await expect(tx.uow(async (nested) => {
        await nested.raw(sql`select 1`).execute();
        throw new Error("nested");
      })).rejects.toThrow("nested");
    });

    expect(queries).toEqual([
      "begin",
      "savepoint forge_sp_1",
      "select 1",
      "rollback to savepoint forge_sp_1",
      "commit",
    ]);
  });

  test("preserves nested application errors when savepoint rollback fails", async () => {
    const { db, queries } = createFailingRollbackDb();

    await db.uow(async (tx) => {
      await expect(tx.uow(async () => {
        throw new Error("nested");
      })).rejects.toThrow("nested");
    });

    expect(queries).toEqual([
      "begin",
      "savepoint forge_sp_1",
      "rollback to savepoint forge_sp_1",
      "commit",
    ]);
  });

  test("applies isolation level on outer transactions", async () => {
    const { db, queries } = createRecordingDb();

    await db.uow(async () => undefined, { isolationLevel: "serializable" });

    expect(queries).toEqual(["begin isolation level serializable", "commit"]);
  });

  test("retries when the configured policy accepts the failure", async () => {
    const { db, queries } = createRecordingDb();
    let calls = 0;

    await db.uow(async () => {
      calls += 1;
      if (calls === 1) throw new Error("retry me");
    }, {
      retries: 1,
      shouldRetry: () => true,
    });

    expect(calls).toBe(2);
    expect(queries).toEqual(["begin", "rollback", "begin", "commit"]);
  });

  test("retries nested work with a fresh savepoint when configured", async () => {
    const { db, queries } = createRecordingDb();
    let calls = 0;

    await db.uow(async (tx) => {
      await tx.uow(async () => {
        calls += 1;
        if (calls === 1) throw new Error("retry me");
      }, {
        retries: 1,
        shouldRetry: () => true,
      });
    });

    expect(calls).toBe(2);
    expect(queries).toEqual([
      "begin",
      "savepoint forge_sp_1",
      "rollback to savepoint forge_sp_1",
      "savepoint forge_sp_2",
      "release savepoint forge_sp_2",
      "commit",
    ]);
  });
});
