import { describe, expect, test } from "bun:test";
import { createPostgresDialect } from "../../src/data/dialects/postgres";
import { createSqliteDialect } from "../../src/data/dialects/sqlite";
import { alterTable, createTable, dropTable } from "../../src/data/schema";

describe("data schema builders", () => {
  test("compiles create table SQL for PostgreSQL", () => {
    const query = createTable("users")
      .column("id", "uuid", { primaryKey: true })
      .column("email", "varchar", { notNull: true, unique: true })
      .column("created_at", "timestamptz", { notNull: true, default: "now()" })
      .compile(createPostgresDialect());

    expect(query.text).toBe(
      'create table "users" ("id" uuid primary key, "email" varchar not null unique, "created_at" timestamptz not null default now())',
    );
  });

  test("compiles SQLite-compatible column types", () => {
    const query = createTable("events")
      .column("id", "uuid", { primaryKey: true })
      .column("payload", "jsonb", { notNull: true })
      .column("active", "boolean", { notNull: true })
      .compile(createSqliteDialect());

    expect(query.text).toBe(
      'create table "events" ("id" text primary key, "payload" text not null, "active" integer not null)',
    );
  });

  test("compiles drop and alter table SQL", () => {
    const dialect = createSqliteDialect();

    expect(dropTable("users").ifExistsOption().compile(dialect).text).toBe(
      'drop table if exists "users"',
    );
    expect(alterTable("users").addColumn("enabled", "boolean").compile(dialect).text).toBe(
      'alter table "users" add column "enabled" integer',
    );
  });
});
