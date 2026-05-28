import { describe, expect, test } from "bun:test";
import { t } from "../../../src/config/schema/builder";
import {
  collectLeaves,
  deepFreeze,
  pathToEnvVar,
  setAtPath,
} from "../../../src/config/schema/walk";

describe("pathToEnvVar", () => {
  test("maps single segment to SCREAMING_SNAKE", () => {
    expect(pathToEnvVar(["port"])).toBe("PORT");
  });

  test("joins nested segments with underscore", () => {
    expect(pathToEnvVar(["db", "pool", "max"])).toBe("DB_POOL_MAX");
  });

  test("inserts underscores at camelCase boundaries", () => {
    expect(pathToEnvVar(["cache", "redisUrl"])).toBe("CACHE_REDIS_URL");
  });
});

describe("collectLeaves", () => {
  test("walks nested objects in insertion order", () => {
    const schema = {
      app: {
        name: t.string.default("app"),
        port: t.port.default(3000),
      },
      db: {
        url: t.url.required(),
      },
    };
    const leaves = collectLeaves(schema);
    expect(leaves.map((l) => l.path)).toEqual(["app.name", "app.port", "db.url"]);
    expect(leaves.map((l) => l.envVar)).toEqual(["APP_NAME", "APP_PORT", "DB_URL"]);
  });

  test("respects .env() overrides", () => {
    const schema = {
      db: {
        url: t.url.required().env("DATABASE_URL"),
      },
    };
    const [leaf] = collectLeaves(schema);
    expect(leaf!.envVar).toBe("DATABASE_URL");
  });
});

describe("setAtPath", () => {
  test("creates nested objects on demand", () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, "a.b.c", 42);
    expect(target).toEqual({ a: { b: { c: 42 } } });
  });

  test("preserves sibling values when adding to an existing object", () => {
    const target: Record<string, unknown> = { a: { existing: true } };
    setAtPath(target, "a.added", 1);
    expect(target).toEqual({ a: { existing: true, added: 1 } });
  });
});

describe("deepFreeze", () => {
  test("freezes the root and every nested object", () => {
    const obj = { a: { b: { c: 1 } } };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.a)).toBe(true);
    expect(Object.isFrozen(obj.a.b)).toBe(true);
  });

  test("mutation throws in strict mode after deep freeze", () => {
    "use strict";
    const obj = deepFreeze({ a: { b: 1 } });
    expect(() => {
      (obj as { a: { b: number } }).a.b = 2;
    }).toThrow();
  });

  test("passes through primitives unchanged", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("hello")).toBe("hello");
    expect(deepFreeze(null)).toBe(null);
  });
});
