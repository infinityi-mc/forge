import { describe, expect, test } from "bun:test";
import { createDb, QueryError, sql } from "../../src/data";
import { createSqliteDialect, createSqliteDriver } from "../../src/data/dialects/sqlite";

describe("data errors", () => {
  test("exposes QueryError metadata", async () => {
    const db = createDb({
      dialect: createSqliteDialect(),
      driver: createSqliteDriver(),
    });

    try {
      await db.raw(sql`select * from missing_table where id = ${123}`).execute();
      throw new Error("expected query failure");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      const queryError = err as QueryError;
      expect(queryError.sql).toBe("select * from missing_table where id = ?");
      expect(queryError.params).toEqual([123]);
      expect(queryError.dialect).toBe("sqlite");
    }
  });
});
