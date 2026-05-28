import { describe, expect, test } from "bun:test";
import { raw, sql } from "../../src/data/sql";

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
});
