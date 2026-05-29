import { describe, expect, test } from "bun:test";
import { MigrationError, migrate, sql } from "../../src/data";
import type { Migration } from "../../src/data/migrations";
import { createSqliteTestDb } from "../../src/data/testing";

interface TestDb {
  users: {
    id: number;
    email: string;
  };
}

describe("data migrations", () => {
  test("applies pending migrations in version order and records state", async () => {
    const db = createSqliteTestDb<TestDb>();
    const seen: string[] = [];
    const migrations: Migration[] = [
      {
        version: "002",
        name: "seed_users",
        async up(tx) {
          seen.push("002");
          await tx.raw(sql`insert into users (email) values (${"a@example.com"})`).execute();
        },
      },
      {
        version: "001",
        name: "create_users",
        async up(tx) {
          seen.push("001");
          await tx.raw(sql`create table users (id integer primary key, email text not null)`).execute();
        },
      },
    ];

    const result = await migrate(db, { migrations });

    expect(seen).toEqual(["001", "002"]);
    expect(result.applied.map((migration) => migration.version)).toEqual(["001", "002"]);

    const rows = await db.raw<{ version: string }>(sql`
      select version from _forge_migrations order by version
    `).execute();
    expect(rows.rows.map((row) => row.version)).toEqual(["001", "002"]);

    await db.shutdown();
  });

  test("rolls back all changes when a migration fails", async () => {
    const db = createSqliteTestDb<TestDb>();
    const migrations: Migration[] = [
      {
        version: "001",
        name: "create_users",
        async up(tx) {
          await tx.raw(sql`create table users (id integer primary key)`).execute();
        },
      },
      {
        version: "002",
        name: "fail",
        up() {
          throw new Error("stop");
        },
      },
    ];

    await expect(migrate(db, { migrations })).rejects.toThrow("stop");
    const state = await db.raw(sql`select version from _forge_migrations`).execute();
    expect(state.rows).toEqual([]);

    await db.shutdown();
  });

  test("rejects duplicate migration versions", async () => {
    const db = createSqliteTestDb();
    const migrations: Migration[] = [
      { version: "001", name: "one", up() {} },
      { version: "001", name: "two", up() {} },
    ];

    await expect(migrate(db, { migrations })).rejects.toThrow(MigrationError);
    await db.shutdown();
  });

  test("runs down migrations in reverse applied order", async () => {
    const db = createSqliteTestDb<TestDb>();
    const migrations: Migration[] = [
      {
        version: "001",
        name: "create_users",
        async up(tx) {
          await tx.raw(sql`create table users (id integer primary key, email text)`).execute();
        },
        async down(tx) {
          await tx.raw(sql`drop table users`).execute();
        },
      },
      {
        version: "002",
        name: "noop",
        up() {},
        down() {},
      },
    ];

    await migrate(db, { migrations });
    const result = await migrate(db, { migrations, direction: "down", to: "001" });

    expect(result.applied.map((migration) => migration.version)).toEqual(["002"]);
    const state = await db.raw<{ version: string }>(sql`
      select version from _forge_migrations order by version
    `).execute();
    expect(state.rows.map((row) => row.version)).toEqual(["001"]);

    await db.shutdown();
  });

  test("dry run reports pending migrations without applying them", async () => {
    const db = createSqliteTestDb();
    const result = await migrate(db, {
      dryRun: true,
      migrations: [{ version: "001", name: "one", up() {} }],
    });

    expect(result.pending.map((migration) => migration.version)).toEqual(["001"]);
    expect(result.applied).toEqual([]);

    await db.shutdown();
  });

  test("uses migration sort order for to-boundary filtering", async () => {
    const db = createSqliteTestDb();
    const migrations: Migration[] = [
      { version: "V2.0", name: "upper", up() {}, down() {} },
      { version: "v1.0", name: "lower", up() {}, down() {} },
    ];

    const preview = await migrate(db, {
      dryRun: true,
      migrations,
      to: "v1.0",
    });
    expect(preview.pending.map((migration) => migration.version)).toEqual(["v1.0"]);

    await migrate(db, { migrations });
    const down = await migrate(db, {
      direction: "down",
      migrations,
      to: "v1.0",
    });
    expect(down.applied.map((migration) => migration.version)).toEqual(["V2.0"]);

    await db.shutdown();
  });
});
