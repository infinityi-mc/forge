import { describe, expect, test } from "bun:test";
import { compileRaw } from "../../src/data/query/compile";
import { raw, sql } from "../../src/data/sql";
import type { Dialect } from "../../src/data/types";

describe("sql", () => {
  test("collects values as parameters", () => {
    const email = "a@example.com";
    const query = sql`select * from users where email = ${email}`;

    expect(query.text).toBe("select * from users where email = ?");
    expect(query.params).toEqual([email]);
  });

  test("composes existing fragments deliberately", () => {
    const predicate = sql`email = ${"a@example.com"}`;
    const query = sql`select * from users where ${predicate} ${raw("limit 1")}`;

    expect(query.text).toBe("select * from users where email = ? limit 1");
    expect(query.params).toEqual(["a@example.com"]);
  });

  test("raw compilation rewrites placeholders through the active dialect", () => {
    const postgresLike: Dialect = {
      name: "postgresql",
      placeholder: (index) => `$${index}`,
      quoteIdentifier: (identifier) => `"${identifier}"`,
    };

    const query = compileRaw(
      postgresLike,
      sql`select * from users where email = ${"a@example.com"} and id = ${123}`,
    );

    expect(query.sql).toBe("select * from users where email = $1 and id = $2");
    expect(query.params).toEqual(["a@example.com", 123]);
  });
});
