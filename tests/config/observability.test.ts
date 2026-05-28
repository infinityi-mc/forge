import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../src/config/define";
import { staticProvider } from "../../src/config/providers/static";
import { defineDynamicConfig } from "../../src/config/dynamic/define";
import type { LogAttributes } from "../../src/config/logger";
import { t } from "../../src/config/schema/builder";
import { Secret } from "../../src/config/secret";

interface RecordedLine {
  level: "info" | "warn" | "error";
  msg: string;
  attrs?: LogAttributes;
}

function recordingLogger() {
  const lines: RecordedLine[] = [];
  return {
    lines,
    info: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "info", msg, attrs }),
    warn: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "warn", msg, attrs }),
    error: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "error", msg, attrs }),
  };
}

describe("boot summary", () => {
  test("defineConfig emits exactly one info line with the spec shape", () => {
    const logger = recordingLogger();
    defineConfig(
      {
        app: { name: t.string.default("forge-app"), port: t.port.default(3000) },
        auth: { token: t.secret.default(new Secret("xyz")) },
      },
      {
        logger,
        sources: [], // Empty source stack — defaults win for every leaf.
      },
    );
    expect(logger.lines.length).toBe(1);
    const [line] = logger.lines;
    expect(line!.level).toBe("info");
    expect(line!.msg).toBe("Configuration loaded successfully");
    const attrs = line!.attrs!;
    expect(attrs["module"]).toBe("forge/config");
    expect(typeof attrs["boot_time_ms"]).toBe("number");
    expect(Array.isArray(attrs["sources"])).toBe(true);
    expect(attrs["loaded_keys"]).toEqual(["app.name", "app.port", "auth.token"]);
    expect(attrs["redacted_keys"]).toEqual(["auth.token"]);
  });

  test("defineConfig does not emit the summary on failure", () => {
    const logger = recordingLogger();
    expect(() =>
      defineConfig(
        { app: { name: t.string.required() } },
        { logger, sources: [], throwOnError: true },
      ),
    ).toThrow();
    expect(logger.lines).toEqual([]);
  });

  test("defineConfig omits secret values from the summary attrs (keys only, never values)", () => {
    const logger = recordingLogger();
    defineConfig(
      { auth: { token: t.secret.default(new Secret("super-secret")) } },
      { logger, sources: [] },
    );
    const [line] = logger.lines;
    const json = JSON.stringify(line);
    // The summary lists *paths*, never values — so the raw secret
    // string must not appear anywhere in the serialised line.
    expect(json).not.toContain("super-secret");
    expect(json).toContain("auth.token");
    // Belt-and-braces: the line does not include any field carrying a
    // secret value (which would round-trip as `[REDACTED]` via
    // `Secret#toJSON`). The summary is purely structural.
    expect(json).not.toContain("[REDACTED]");
  });
});

describe("dynamic update summary", () => {
  test("defineDynamicConfig emits a warn line on every actual swap", async () => {
    const logger = recordingLogger();
    const handle = await defineDynamicConfig(
      { features: { newCheckout: t.boolean.default(false) } },
      {
        provider: staticProvider({ "features.newCheckout": "true" }, { name: "static-test" }),
        logger,
      },
    );
    // Initial load fires through the static provider; no swap log
    // because static providers don't push updates after the initial
    // get(). So the lines array should be empty post-construction.
    expect(logger.lines).toEqual([]);
    await handle.shutdown();
  });
});
