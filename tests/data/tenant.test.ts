import { describe, expect, test } from "bun:test";
import { createDb, sql, TenantError, type Driver } from "../../src/data";
import { createSqliteDialect } from "../../src/data/dialects/sqlite";

interface TestDb {
  users: {
    id: number;
    tenant_id: string;
    email: string;
    status: string;
  };
}

function createTestDb() {
  const driver: Driver = {
    name: "noop",
    execute() {
      return { rows: [], numAffectedRows: 0n };
    },
  };
  return createDb<TestDb>({ dialect: createSqliteDialect(), driver });
}

describe("tenant handles", () => {
  test("injects tenant predicates into table-scoped queries", () => {
    const db = createTestDb().withTenant("tenant-a");

    expect(db.selectFrom("users").where("status", "=", "active").compile()).toMatchObject({
      sql: 'select * from "users" where "tenant_id" = ? and "status" = ?',
      params: ["tenant-a", "active"],
    });

    expect(db.updateTable("users").set({ status: "disabled" }).where("id", "=", 1).compile()).toMatchObject({
      sql: 'update "users" set "status" = ? where "tenant_id" = ? and "id" = ?',
      params: ["disabled", "tenant-a", 1],
    });

    expect(db.deleteFrom("users").where("id", "=", 1).compile()).toMatchObject({
      sql: 'delete from "users" where "tenant_id" = ? and "id" = ?',
      params: ["tenant-a", 1],
    });
  });

  test("adds tenant values to inserts", () => {
    const db = createTestDb().withTenant("tenant-a");

    const query = db
      .insertInto("users")
      .values({ email: "a@example.com", status: "active" })
      .compile();

    expect(query.sql).toBe(
      'insert into "users" ("email", "status", "tenant_id") values (?, ?, ?)',
    );
    expect(query.params).toEqual(["a@example.com", "active", "tenant-a"]);
  });

  test("rejects insert values for a different tenant", () => {
    const db = createTestDb().withTenant("tenant-a");

    expect(() =>
      db.insertInto("users").values({
        email: "a@example.com",
        status: "active",
        tenant_id: "tenant-b",
      }),
    ).toThrow(TenantError);
  });

  test("rejects update tenant values for a different tenant", () => {
    const db = createTestDb().withTenant("tenant-a");

    expect(() =>
      db.updateTable("users").set({
        status: "active",
        tenant_id: "tenant-b",
      }),
    ).toThrow(TenantError);
  });

  test("blocks raw SQL by default and allows it explicitly", () => {
    const blocked = createTestDb().withTenant("tenant-a");
    expect(() => blocked.raw(sql`select 1`)).toThrow(TenantError);

    const allowed = createTestDb().withTenant("tenant-a", { allowRaw: true });
    expect(allowed.raw(sql`select 1`).compile().sql).toBe("select 1");
  });
});
