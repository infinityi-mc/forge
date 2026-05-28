import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { Secret, isSecret } from "../../src/config/secret";

describe("Secret", () => {
  test("unwrap returns the raw value", () => {
    const s = new Secret("super-secret-api-key");
    expect(s.unwrap()).toBe("super-secret-api-key");
  });

  test("toString returns [REDACTED]", () => {
    const s = new Secret("super-secret-api-key");
    expect(s.toString()).toBe("[REDACTED]");
  });

  test("template literals and String() are redacted", () => {
    const s = new Secret("super-secret-api-key");
    expect(`${s}`).toBe("[REDACTED]");
    expect(String(s)).toBe("[REDACTED]");
    expect("token=" + s).toBe("token=[REDACTED]");
  });

  test("JSON.stringify redacts the value", () => {
    const s = new Secret("super-secret-api-key");
    expect(JSON.stringify({ apiKey: s })).toBe('{"apiKey":"[REDACTED]"}');
  });

  test("util.inspect redacts the value", () => {
    const s = new Secret("super-secret-api-key");
    expect(inspect(s)).toBe("Secret <[REDACTED]>");
  });

  test("typed payloads survive — Secret<URL> redacts but unwraps", () => {
    const url = new URL("postgres://user:pass@host/db");
    const s = new Secret(url);
    expect(s.unwrap()).toBe(url);
    expect(JSON.stringify({ db: s })).toBe('{"db":"[REDACTED]"}');
    expect(inspect(s)).toBe("Secret <[REDACTED]>");
  });

  test("isSecret narrows correctly", () => {
    expect(isSecret(new Secret("x"))).toBe(true);
    expect(isSecret("x")).toBe(false);
    expect(isSecret({ unwrap: () => "x" })).toBe(false);
    expect(isSecret(null)).toBe(false);
    expect(isSecret(undefined)).toBe(false);
  });

  test("the raw value is not exposed on any enumerable property", () => {
    const s = new Secret("plain-text-leak-test");
    // No enumerable property of Secret should contain the raw text.
    for (const key of Object.keys(s)) {
      expect(String((s as unknown as Record<string, unknown>)[key])).not.toBe(
        "plain-text-leak-test",
      );
    }
    // Spread should also redact (no own properties carry the raw value).
    const spread = { ...s };
    expect(JSON.stringify(spread)).not.toContain("plain-text-leak-test");
  });
});
