import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as data from "../../src/data";

describe("data exports", () => {
  test("data symbols stay scoped to forge/data rather than the package root", () => {
    expect(data.createDb).toBeFunction();
    expect("createDb" in root).toBe(false);
    expect("sql" in root).toBe(false);
  });
});
