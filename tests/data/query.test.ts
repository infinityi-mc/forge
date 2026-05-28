import { describe, expect, test } from "bun:test";
import { createDb, sql } from "../../src/data";
import { createSqliteDialect, createSqliteDriver } from "../../src/data/dialects/sqlite";

interface TestDb {
  users: {
    id: number;
    email: string;
    status: "active" | "disabled";
    created_at: string;
  };
}

function createTestDb() {
  const db = createDb<TestDb>({
    dialect: createSqliteDialect(),
    driver: createSqliteDriver(),
  });
  return db;
}

async function seed(db: ReturnType<typeof createTestDb>) {
  await db.raw(sql`
    create table users (
      id integer primary key autoincrement,
      email text not null,
      status text not null,
      created_at text not null
    )
  `).execute();

  await db
    .insertInto("users")
    .values([
      { email: "a@example.com", status: "active", created_at: "2026-01-02" },
      { email: "b@example.com", status: "disabled", created_at: "2026-01-03" },
      { email: "c@example.com", status: "active", created_at: "2026-01-04" },
    ])
    .execute();
}

describe("query builders", () => {
  test("compiles parameterized select SQL", () => {
    const db = createTestDb();
    const query = db
      .selectFrom("users")
      .select(["id", "email"] as const)
      .where("status", "=", "active")
      .orderBy("created_at", "desc")
      .limit(10)
      .compile();

    expect(query.sql).toBe(
      'select "id", "email" from "users" where "status" = ? order by "created_at" desc limit ?',
    );
    expect(query.params).toEqual(["active", 10]);
  });

  test("compiles returning queries with explicit returning metadata", () => {
    const db = createTestDb();
    const query = db
      .deleteFrom("users")
      .where("id", "=", 999)
      .returning(["id"] as const)
      .compile();

    expect(query.returning).toBe(true);
    expect(query.sql).toBe('delete from "users" where "id" = ? returning "id"');
  });

  test("executes select, insert returning, update, and delete through SQLite", async () => {
    const db = createTestDb();
    await seed(db);

    const activeUsers = await db
      .selectFrom("users")
      .select(["id", "email"] as const)
      .where("status", "=", "active")
      .orderBy("created_at", "desc")
      .execute();

    expect(activeUsers.rows.map((row) => row.email)).toEqual([
      "c@example.com",
      "a@example.com",
    ]);

    const inserted = await db
      .insertInto("users")
      .values({ email: "d@example.com", status: "active", created_at: "2026-01-05" })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBeNumber();
    expect(inserted.email).toBe("d@example.com");

    const updated = await db
      .updateTable("users")
      .set({ status: "disabled" })
      .where("email", "=", "a@example.com")
      .executeTakeFirstOrThrow();

    expect(updated.numUpdatedRows).toBe(1n);

    const deleted = await db
      .deleteFrom("users")
      .where("status", "=", "disabled")
      .executeTakeFirstOrThrow();

    expect(deleted.numDeletedRows).toBe(2n);

    await db.shutdown();
  });

  test("returning update/delete that match zero rows return an empty result, not synthetic count rows", async () => {
    const db = createTestDb();
    await seed(db);

    const updated = await db
      .updateTable("users")
      .set({ status: "disabled" })
      .where("id", "=", 999)
      .returning(["id"] as const)
      .execute();

    expect(updated.rows).toEqual([]);

    const deleted = await db
      .deleteFrom("users")
      .where("id", "=", 999)
      .returning(["id"] as const)
      .execute();

    expect(deleted.rows).toEqual([]);

    await db.shutdown();
  });
});
