import { describe, expect, test } from "bun:test";
import { ConcurrencyError, expectUpdated } from "../../src/data";

describe("optimistic concurrency helpers", () => {
  test("returns successful update results", () => {
    const result = { numUpdatedRows: 1n };

    expect(expectUpdated(result)).toBe(result);
  });

  test("throws when no rows were updated", () => {
    expect(() => expectUpdated({ numUpdatedRows: 0n })).toThrow(ConcurrencyError);
  });

  test("supports delete counts", () => {
    expect(() => expectUpdated({ numDeletedRows: 0n }, "missing row")).toThrow("missing row");
  });
});
