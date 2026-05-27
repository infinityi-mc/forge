import { describe, expect, test } from "bun:test";
import {
  genSpanId,
  genTraceId,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
  isValidSpanId,
  isValidTraceId,
} from "../../../src/telemetry/context";

describe("genTraceId", () => {
  test("returns a 32 lower-case hex string", () => {
    const id = genTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("never returns the same id back-to-back (probabilistic)", () => {
    const a = genTraceId();
    const b = genTraceId();
    expect(a).not.toBe(b);
  });

  test("emitted ids are valid by isValidTraceId", () => {
    expect(isValidTraceId(genTraceId())).toBe(true);
  });
});

describe("genSpanId", () => {
  test("returns a 16 lower-case hex string", () => {
    const id = genSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("emitted ids are valid by isValidSpanId", () => {
    expect(isValidSpanId(genSpanId())).toBe(true);
  });
});

describe("isValidTraceId", () => {
  test("rejects the all-zero invalid trace id", () => {
    expect(isValidTraceId(INVALID_TRACE_ID)).toBe(false);
  });

  test("rejects wrong-length strings", () => {
    expect(isValidTraceId("abc")).toBe(false);
    expect(isValidTraceId("0".repeat(33))).toBe(false);
  });

  test("rejects upper-case hex (W3C requires lower-case)", () => {
    expect(isValidTraceId("A".repeat(32))).toBe(false);
  });

  test("accepts a valid id", () => {
    expect(isValidTraceId("0af7651916cd43dd8448eb211c80319c")).toBe(true);
  });
});

describe("isValidSpanId", () => {
  test("rejects the all-zero invalid span id", () => {
    expect(isValidSpanId(INVALID_SPAN_ID)).toBe(false);
  });

  test("accepts a valid id", () => {
    expect(isValidSpanId("b7ad6b7169203331")).toBe(true);
  });
});
