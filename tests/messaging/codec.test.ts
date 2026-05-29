import { describe, expect, test } from "bun:test";
import { jsonCodec } from "../../src/messaging";
import { SerializationError } from "../../src/messaging/errors";

describe("jsonCodec", () => {
  test("round-trips a payload through encode/decode", () => {
    const codec = jsonCodec();
    const payload = { hello: "world", n: 42, nested: { ok: true }, arr: [1, 2] };
    const decoded = codec.decode(codec.encode(payload));
    expect(decoded).toEqual(payload);
  });

  test("advertises application/json", () => {
    expect(jsonCodec().contentType).toBe("application/json");
  });

  test("rejects payloads that JSON-encode to undefined", () => {
    const codec = jsonCodec();
    expect(() => codec.encode(undefined)).toThrow(SerializationError);
  });

  test("rejects values JSON.stringify cannot represent", () => {
    const codec = jsonCodec();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => codec.encode(circular)).toThrow(SerializationError);
  });

  test("rejects invalid JSON on decode", () => {
    const codec = jsonCodec();
    const garbage = new TextEncoder().encode("{not json");
    expect(() => codec.decode(garbage)).toThrow(SerializationError);
  });
});
