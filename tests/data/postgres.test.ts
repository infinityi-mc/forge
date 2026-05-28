import { describe, expect, test } from "bun:test";
import { createDb, sql } from "../../src/data";
import {
  createPostgresDialect,
  createPostgresDriver,
  isFatalPostgresError,
  isRetryablePostgresError,
} from "../../src/data/dialects/postgres";

interface TestDb {
  users: {
    id: number;
    email: string;
    status: string;
  };
}

describe("postgres dialect", () => {
  test("compiles numbered placeholders and quoted identifiers", () => {
    const db = createDb<TestDb>({
      dialect: createPostgresDialect(),
      driver: createPostgresDriver({
        client: { query: () => ({ rows: [], rowCount: 0 }) },
        closeOnShutdown: false,
      }),
    });

    const query = db
      .selectFrom("users")
      .select(["id", "email"] as const)
      .where("status", "=", "active")
      .limit(5)
      .compile();

    expect(query.sql).toBe(
      'select "id", "email" from "users" where "status" = $1 limit $2',
    );
    expect(query.params).toEqual(["active", 5]);
  });

  test("raw SQL placeholders are rewritten for PostgreSQL", () => {
    const db = createDb<TestDb>({
      dialect: createPostgresDialect(),
      driver: createPostgresDriver({
        client: { query: () => ({ rows: [], rowCount: 0 }) },
        closeOnShutdown: false,
      }),
    });

    const query = db.raw(sql`select * from users where email = ${"a"} and id = ${1}`).compile();
    expect(query.sql).toBe("select * from users where email = $1 and id = $2");
  });
});

describe("postgres driver", () => {
  test("adapts a peer client query result", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const driver = createPostgresDriver({
      client: {
        query<Row = unknown>(sqlText: string, params?: readonly unknown[]) {
          calls.push({ sql: sqlText, params });
          return { rows: [{ id: 1 } as Row], rowCount: 1 };
        },
      },
      closeOnShutdown: false,
    });

    const result = await driver.execute<{ id: number }>({
      sql: "select $1::int as id",
      params: [1],
      kind: "raw",
      returning: false,
    });

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.numAffectedRows).toBe(1n);
    expect(calls).toEqual([{ sql: "select $1::int as id", params: [1] }]);
  });

  test("classifies retryable and fatal SQLSTATE codes", () => {
    expect(isRetryablePostgresError({ code: "40001" })).toBe(true);
    expect(isRetryablePostgresError({ code: "40P01" })).toBe(true);
    expect(isRetryablePostgresError({ code: "23505" })).toBe(false);
    expect(isFatalPostgresError({ code: "57P01" })).toBe(true);
    expect(isFatalPostgresError({ code: "23505" })).toBe(false);
  });
});
