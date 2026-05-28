import { describe, expect, test } from "bun:test";
import { Secret } from "../../../src/config/secret";
import { t } from "../../../src/config/schema/builder";

describe("t.string", () => {
  test("trims whitespace and returns the string", () => {
    const result = t.string.parse("  hello  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
  });

  test("rejects empty / whitespace-only input", () => {
    const result = t.string.parse("   ");
    expect(result.ok).toBe(false);
  });

  test(".url variant validates URL shape and keeps string type", () => {
    const ok = t.string.url.parse("https://example.com/path");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(typeof ok.value).toBe("string");
    const bad = t.string.url.parse("not a url");
    expect(bad.ok).toBe(false);
  });

  test(".email variant validates email shape", () => {
    const ok = t.string.email.parse("ada@example.com");
    expect(ok.ok).toBe(true);
    const bad = t.string.email.parse("not-an-email");
    expect(bad.ok).toBe(false);
  });
});

describe("t.number / t.number.int", () => {
  test("parses floats", () => {
    const r = t.number.parse("3.14");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3.14);
  });

  test("rejects NaN / Infinity / trailing garbage", () => {
    expect(t.number.parse("abc").ok).toBe(false);
    expect(t.number.parse("3px").ok).toBe(false);
    expect(t.number.parse("Infinity").ok).toBe(false);
    expect(t.number.parse("NaN").ok).toBe(false);
  });

  test(".int rejects non-integer values", () => {
    const bad = t.number.int.parse("3.14");
    expect(bad.ok).toBe(false);
    const ok = t.number.int.parse("42");
    expect(ok.ok).toBe(true);
  });

  test("getter returns fresh instances — int does not bleed across reads", () => {
    const a = t.number.int;
    const b = t.number;
    expect(a.isInt).toBe(true);
    expect(b.isInt).toBe(false);
  });
});

describe("t.boolean", () => {
  test("accepts canonical truthy and falsy tokens (any casing)", () => {
    for (const truth of ["true", "TRUE", "1", "yes", "Yes"]) {
      const r = t.boolean.parse(truth);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(true);
    }
    for (const falsy of ["false", "FALSE", "0", "no", "No"]) {
      const r = t.boolean.parse(falsy);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(false);
    }
  });

  test("rejects anything else with a clear diagnostic", () => {
    const r = t.boolean.parse("maybe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Must be one of");
  });
});

describe("t.port", () => {
  test("accepts integers in [1, 65535]", () => {
    expect(t.port.parse("1").ok).toBe(true);
    expect(t.port.parse("3000").ok).toBe(true);
    expect(t.port.parse("65535").ok).toBe(true);
  });

  test("rejects out-of-bounds values", () => {
    const r = t.port.parse("99999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("out of bounds");
    expect(t.port.parse("0").ok).toBe(false);
    expect(t.port.parse("-1").ok).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(t.port.parse("3.14").ok).toBe(false);
    expect(t.port.parse("not-a-number").ok).toBe(false);
  });
});

describe("t.url / t.url.secret()", () => {
  test("parses a URL into a native URL object", () => {
    const r = t.url.parse("postgres://user:pass@host:5432/db");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeInstanceOf(URL);
      expect(r.value.protocol).toBe("postgres:");
    }
  });

  test("invalid URL produces a diagnostic", () => {
    const r = t.url.parse("not a url");
    expect(r.ok).toBe(false);
  });

  test(".secret() wraps the URL in Secret and flags isSecret", () => {
    const leaf = t.url.secret();
    expect(leaf.isSecret).toBe(true);
    const r = leaf.parse("postgres://user:pass@host:5432/db");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeInstanceOf(Secret);
      expect(r.value.unwrap()).toBeInstanceOf(URL);
      // Logging a Secret<URL> redacts the whole URL, including the password.
      expect(JSON.stringify({ db: r.value })).toBe('{"db":"[REDACTED]"}');
    }
  });
});

describe("t.enum", () => {
  test("restricts to declared variants", () => {
    const env = t.enum(["development", "staging", "production"] as const);
    expect(env.parse("staging").ok).toBe(true);
    expect(env.parse("preview").ok).toBe(false);
  });

  test("rejects empty variant list at schema construction time", () => {
    expect(() => t.enum([] as readonly string[])).toThrow();
  });

  test("variant list is exposed for diagnostics", () => {
    const env = t.enum(["a", "b"] as const);
    expect(env.variants).toEqual(["a", "b"]);
  });
});

describe("t.secret", () => {
  test("wraps the value in Secret and marks the leaf secret", () => {
    expect(t.secret.isSecret).toBe(true);
    const r = t.secret.parse("super-secret-key");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBeInstanceOf(Secret);
      expect(r.value.unwrap()).toBe("super-secret-key");
    }
  });

  test("does NOT trim — preserves trailing newlines / whitespace verbatim", () => {
    const value = "base64-secret-with-=padding\n";
    const r = t.secret.parse(value);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.unwrap()).toBe(value);
  });

  test("rejects empty input", () => {
    expect(t.secret.parse("").ok).toBe(false);
  });
});

describe("t.json", () => {
  test("parses JSON strings into typed objects", () => {
    interface Feature {
      readonly enabled: boolean;
    }
    const r = t.json<Feature>().parse('{"enabled": true}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.enabled).toBe(true);
  });

  test("rejects malformed JSON", () => {
    const r = t.json<unknown>().parse("{not json");
    expect(r.ok).toBe(false);
  });
});

describe("chainable methods", () => {
  test(".default sets a fallback without mutating the source leaf", () => {
    const source = t.string;
    const withDefault = source.default("fallback");
    expect(source.hasDefault).toBe(false);
    expect(withDefault.hasDefault).toBe(true);
    expect(withDefault.defaultValue).toBe("fallback");
  });

  test(".optional widens the type and sets isOptional", () => {
    const leaf = t.url.optional();
    expect(leaf.isOptional).toBe(true);
  });

  test(".env overrides the lookup name", () => {
    const leaf = t.url.required().env("DATABASE_URL");
    expect(leaf.envName).toBe("DATABASE_URL");
  });

  test("chaining preserves leaf-specific state", () => {
    const leaf = t.number.int.default(42).env("MY_NUM");
    expect(leaf.isInt).toBe(true);
    expect(leaf.hasDefault).toBe(true);
    expect(leaf.defaultValue).toBe(42);
    expect(leaf.envName).toBe("MY_NUM");
  });
});
