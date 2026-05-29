import { describe, expect, test } from "bun:test";
import { MigrationError, migrate, sql } from "../../src/data";
import type { Migration } from "../../src/data/migrations";
import { createMigrationSource } from "../../src/data/migrations";
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
      { version: "ä", name: "umlaut", up() {}, down() {} },
      { version: "z", name: "zed", up() {}, down() {} },
    ];

    const preview = await migrate(db, {
      dryRun: true,
      migrations,
      to: "z",
    });
    expect(preview.pending.map((migration) => migration.version)).toEqual(["z"]);

    await migrate(db, { migrations });
    const down = await migrate(db, {
      direction: "down",
      migrations,
      to: "z",
    });
    expect(down.applied.map((migration) => migration.version)).toEqual(["ä"]);

    await db.shutdown();
  });

  test("sorts migrations with deterministic ordinal comparison", async () => {
    const source = createMigrationSource([
      { version: "ä", name: "umlaut", up() {} },
      { version: "z", name: "zed", up() {} },
      { version: "a", name: "ay", up() {} },
    ]);

    const db = createSqliteTestDb();
    const result = await migrate(db, { dryRun: true, migrations: source });

    expect(result.pending.map((migration) => migration.version)).toEqual(["a", "z", "ä"]);
    await db.shutdown();
  });

  test("targeted down migrations reject unknown applied state", async () => {
    const db = createSqliteTestDb();
    await db.raw(sql`
      create table _forge_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at text not null
      )
    `).execute();
    await db.raw(sql`
      insert into _forge_migrations (version, name, checksum, applied_at)
      values (${"999"}, ${"missing"}, ${"missing"}, ${"2026-01-01T00:00:00.000Z"})
    `).execute();
    await db.raw(sql`
      insert into _forge_migrations (version, name, checksum, applied_at)
      values (${"001"}, ${"one"}, ${"one"}, ${"2026-01-01T00:00:00.000Z"})
    `).execute();

    await expect(migrate(db, {
      direction: "down",
      migrations: [{ version: "001", name: "one", up() {}, down() {} }],
      to: "001",
    })).rejects.toThrow("Cannot roll back unknown migration");

    await db.shutdown();
  });
});
