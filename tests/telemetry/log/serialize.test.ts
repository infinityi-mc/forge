import { describe, expect, test } from "bun:test";
import { serializeError } from "../../../src/telemetry/log";

describe("serializeError", () => {
  test("returns the value unchanged when not an Error", () => {
    expect(serializeError("oops")).toBe("oops");
    expect(serializeError(42)).toBe(42);
    expect(serializeError(null)).toBe(null);
  });

  test("extracts name, message, and stack from an Error", () => {
    const err = new TypeError("bad input");
    const out = serializeError(err) as Record<string, unknown>;
    expect(out["name"]).toBe("TypeError");
    expect(out["message"]).toBe("bad input");
    expect(typeof out["stack"]).toBe("string");
  });

  test("recursively serializes Error.cause", () => {
    const root = new Error("root");
    const wrapped = new Error("wrapped", { cause: root });
    const out = serializeError(wrapped) as Record<string, unknown>;
    const cause = out["cause"] as Record<string, unknown>;
    expect(cause["message"]).toBe("root");
  });

  test("breaks cycles via [circular] sentinel", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const out = serializeError(a) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[circular]");
  });

  test("preserves own enumerable properties", () => {
    const err = new Error("x") as Error & { code?: string };
    err.code = "E_BAD";
    const out = serializeError(err) as Record<string, unknown>;
    expect(out["code"]).toBe("E_BAD");
  });
});
