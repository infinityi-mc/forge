import { describe, expect, test } from "bun:test";
import {
  extract,
  formatBaggage,
  formatTraceparent,
  inject,
  objectCarrier,
  parseBaggage,
  parseTraceparent,
  TRACE_FLAGS,
} from "../../../src/telemetry/context";

const VALID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("parseTraceparent", () => {
  test("parses a valid header", () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
  });

  test("rejects malformed lengths", () => {
    expect(parseTraceparent("00-abc-def-01")).toBeUndefined();
    expect(parseTraceparent("not-a-header")).toBeUndefined();
  });

  test("rejects version ff", () => {
    expect(
      parseTraceparent(
        "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      ),
    ).toBeUndefined();
  });

  test("rejects all-zero ids", () => {
    expect(
      parseTraceparent("00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-00"),
    ).toBeUndefined();
  });

  test("rejects upper-case ids (spec requires lower-case)", () => {
    expect(
      parseTraceparent(
        "00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01",
      ),
    ).toBeUndefined();
  });
});

describe("formatTraceparent", () => {
  test("round-trips with parseTraceparent", () => {
    const header = formatTraceparent({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      baggage: {},
    });
    expect(header).toBe(VALID);
    expect(parseTraceparent(header)).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
  });

  test("emits flags as two lower-case hex digits", () => {
    const header = formatTraceparent({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TRACE_FLAGS.NONE,
      baggage: {},
    });
    expect(header.endsWith("-00")).toBe(true);
  });
});

describe("parseBaggage / formatBaggage", () => {
  test("round-trips simple keys", () => {
    const value = formatBaggage({ a: "1", b: "two" });
    expect(parseBaggage(value)).toEqual({ a: "1", b: "two" });
  });

  test("URL-decodes values", () => {
    expect(parseBaggage("k=hello%20world")).toEqual({ k: "hello world" });
  });

  test("drops malformed entries silently", () => {
    expect(parseBaggage(",foo,no_equals,=novalue,k=v")).toEqual({ k: "v" });
  });

  test("ignores ;property=metadata suffix", () => {
    expect(parseBaggage("k=v;prop=ignored")).toEqual({ k: "v" });
  });
});

describe("inject / extract", () => {
  test("round-trips a context through a header carrier", () => {
    const headers: Record<string, string> = {};
    inject(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        baggage: { tenantId: "acme" },
        traceState: "vendor=foo",
      },
      objectCarrier(headers),
    );
    expect(headers).toHaveProperty("traceparent", VALID);
    expect(headers).toHaveProperty("tracestate", "vendor=foo");
    expect(headers).toHaveProperty("baggage");

    const back = extract(objectCarrier(headers));
    expect(back).toBeDefined();
    expect(back!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(back!.spanId).toBe("b7ad6b7169203331");
    expect(back!.baggage).toEqual({ tenantId: "acme" });
    expect(back!.traceState).toBe("vendor=foo");
  });

  test("extract returns undefined when traceparent is missing", () => {
    expect(extract(objectCarrier({}))).toBeUndefined();
  });

  test("extract tolerates malformed baggage", () => {
    const headers: Record<string, string> = {
      traceparent: VALID,
      baggage: ",,not_valid",
    };
    expect(extract(objectCarrier(headers))).toBeDefined();
  });

  test("objectCarrier lookups are case-insensitive", () => {
    const carrier = objectCarrier({ TraceParent: VALID });
    expect(extract(carrier)).toBeDefined();
  });
});
