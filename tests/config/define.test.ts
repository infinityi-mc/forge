import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../src/config/define";
import { ConfigValidationError } from "../../src/config/errors";
import { Secret } from "../../src/config/secret";
import { t } from "../../src/config/schema/builder";
import { envSource } from "../../src/config/sources/env";

/**
 * Most tests inject `sources: [envSource({ env: { ... } })]` so they
 * stay deterministic regardless of the surrounding shell. `throwOnError`
 * is set everywhere we expect failure to keep the test process alive
 * (otherwise `defineConfig` calls `process.exit(1)`).
 */

describe("defineConfig — happy paths", () => {
  test("loads required values from the env source", () => {
    const config = defineConfig(
      {
        app: { port: t.port.required() },
        db: { url: t.url.required() },
      },
      {
        sources: [envSource({ env: { APP_PORT: "8080", DB_URL: "postgres://h/db" } })],
        throwOnError: true,
      },
    );
    expect(config.app.port).toBe(8080);
    expect(config.db.url).toBeInstanceOf(URL);
    expect(config.db.url.host).toBe("h");
  });

  test("falls back to schema defaults when env is absent", () => {
    const config = defineConfig(
      { app: { port: t.port.default(3000) } },
      { sources: [envSource({ env: {} })], throwOnError: true },
    );
    expect(config.app.port).toBe(3000);
  });

  test("optional leaves resolve to undefined", () => {
    const config = defineConfig(
      { cache: { redisUrl: t.url.optional() } },
      { sources: [envSource({ env: {} })], throwOnError: true },
    );
    expect(config.cache.redisUrl).toBeUndefined();
  });

  test(".env() override is honored", () => {
    const config = defineConfig(
      { db: { url: t.url.required().env("DATABASE_URL") } },
      {
        sources: [envSource({ env: { DATABASE_URL: "postgres://h/db" } })],
        throwOnError: true,
      },
    );
    expect(config.db.url.host).toBe("h");
  });

  test("nested camelCase keys are mapped to SCREAMING_SNAKE", () => {
    const config = defineConfig(
      { cache: { redisUrl: t.url.required() } },
      {
        sources: [envSource({ env: { CACHE_REDIS_URL: "redis://h:6379" } })],
        throwOnError: true,
      },
    );
    expect(config.cache.redisUrl.hostname).toBe("h");
    expect(config.cache.redisUrl.port).toBe("6379");
  });

  test("Secret values redact under JSON.stringify but unwrap to the raw value", () => {
    const config = defineConfig(
      { auth: { jwtSecret: t.secret.required() } },
      {
        sources: [envSource({ env: { AUTH_JWT_SECRET: "super-secret-key" } })],
        throwOnError: true,
      },
    );
    expect(config.auth.jwtSecret).toBeInstanceOf(Secret);
    expect(config.auth.jwtSecret.unwrap()).toBe("super-secret-key");
    expect(JSON.stringify(config.auth)).toBe('{"jwtSecret":"[REDACTED]"}');
  });
});

describe("defineConfig — fail-fast diagnostics", () => {
  test("missing required leaf throws with structured issues", () => {
    expect(() =>
      defineConfig(
        { app: { env: t.enum(["dev", "prod"] as const).required() } },
        { sources: [envSource({ env: {} })], throwOnError: true },
      ),
    ).toThrow(ConfigValidationError);

    try {
      defineConfig(
        { app: { env: t.enum(["dev", "prod"] as const).required() } },
        { sources: [envSource({ env: {} })], throwOnError: true },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toBe("app.env");
      expect(issues[0]!.envVar).toBe("APP_ENV");
      expect(issues[0]!.status).toBe("missing");
      expect(issues[0]!.reason).toContain("Must be one of");
    }
  });

  test("invalid value throws with status=invalid and includes received", () => {
    try {
      defineConfig(
        { app: { port: t.port.required() } },
        {
          sources: [envSource({ env: { APP_PORT: "99999" } })],
          throwOnError: true,
        },
      );
      throw new Error("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues[0]!.status).toBe("invalid");
      expect(issues[0]!.received).toBe("99999");
      expect(issues[0]!.reason).toContain("out of bounds");
    }
  });

  test("never echoes the raw value of a secret in diagnostics", () => {
    try {
      defineConfig(
        { auth: { jwtSecret: t.secret.required() } },
        {
          // Empty string fails the parser (secrets reject empty).
          sources: [envSource({ env: { AUTH_JWT_SECRET: "" } })],
          throwOnError: true,
        },
      );
      throw new Error("expected ConfigValidationError");
    } catch (err) {
      const issues = (err as ConfigValidationError).issues;
      expect(issues[0]!.received).toBeUndefined();
    }
  });

  test("aggregates every issue before failing — never short-circuits on the first", () => {
    try {
      defineConfig(
        {
          app: {
            env: t.enum(["dev", "prod"] as const).required(),
            port: t.port.required(),
          },
          db: { url: t.url.required() },
        },
        { sources: [envSource({ env: {} })], throwOnError: true },
      );
      throw new Error("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues).toHaveLength(3);
      expect(issues.map((i) => i.envVar)).toEqual([
        "APP_ENV",
        "APP_PORT",
        "DB_URL",
      ]);
    }
  });

  test("renders to stderr and exits with code 1 by default", () => {
    let exited: number | undefined;
    let output = "";
    expect(() =>
      defineConfig(
        { app: { port: t.port.required() } },
        {
          sources: [envSource({ env: {} })],
          diagnostics: {
            stderr: { write: (chunk: string) => (output += chunk) },
            exit: ((code: number) => {
              exited = code;
              throw new Error("simulated exit");
            }) as (code: number) => never,
          },
        },
      ),
    ).toThrow();
    expect(exited).toBe(1);
    expect(output).toContain("Forge Configuration Error");
    expect(output).toContain("APP_PORT");
  });
});

describe("defineConfig — deep freeze", () => {
  test("root and nested objects are frozen", () => {
    const config = defineConfig(
      { app: { port: t.port.default(3000) } },
      { sources: [envSource({ env: {} })], throwOnError: true },
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
  });

  test("mutation throws in strict mode", () => {
    "use strict";
    const config = defineConfig(
      { app: { port: t.port.default(3000) } },
      { sources: [envSource({ env: {} })], throwOnError: true },
    );
    expect(() => {
      (config.app as { port: number }).port = 9999;
    }).toThrow();
  });
});

describe("defineConfig — environment fence on .env", () => {
  test("CLI overrides env which overrides .env which overrides defaults", () => {
    // Build the source stack manually to demonstrate priority.
    const config = defineConfig(
      { app: { port: t.port.default(1000) } },
      {
        sources: [
          // lowest priority first
          envSource({ env: { APP_PORT: "3000" } }),
          envSource({ env: { APP_PORT: "8080" } }),
        ],
        throwOnError: true,
      },
    );
    // The second `envSource` (later in the array) wins.
    expect(config.app.port).toBe(8080);
  });
});
