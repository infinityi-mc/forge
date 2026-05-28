import { describe, expect, test } from "bun:test";
import { envSource } from "../../../src/config/sources/env";

describe("envSource", () => {
  test("reads from supplied env map", () => {
    const source = envSource({ env: { APP_PORT: "3000", FOO: "bar" } });
    expect(source.get({ path: "app.port", envVar: "APP_PORT" })).toBe("3000");
    expect(source.get({ path: "foo", envVar: "FOO" })).toBe("bar");
  });

  test("returns undefined for missing keys", () => {
    const source = envSource({ env: {} });
    expect(source.get({ path: "x", envVar: "X" })).toBeUndefined();
  });

  test("name is `env` for boot summary", () => {
    expect(envSource({ env: {} }).name).toBe("env");
  });

  test("ignores the dotted path — env-var match only", () => {
    const source = envSource({ env: { "app.port": "3000" } });
    // Path-based lookup should NOT find it; env source matches on envVar.
    expect(source.get({ path: "app.port", envVar: "APP_PORT" })).toBeUndefined();
  });
});
