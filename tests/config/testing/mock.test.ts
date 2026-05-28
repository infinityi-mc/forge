import { describe, expect, test } from "bun:test";
import { defineConfig } from "../../../src/config/define";
import { t } from "../../../src/config/schema/builder";
import { envSource } from "../../../src/config/sources/env";
import { mockConfig } from "../../../src/config/testing";

const schema = {
  app: {
    port: t.port.default(3000),
    name: t.string.default("forge"),
  },
  features: {
    maintenanceMode: t.boolean.default(false),
  },
};

type AppConfig = {
  readonly app: {
    readonly port: number;
    readonly name: string;
  };
  readonly features: {
    readonly maintenanceMode: boolean;
  };
};

function loadConfig(): AppConfig {
  return defineConfig(schema, {
    sources: [envSource({ env: {} })],
    throwOnError: true,
  });
}

describe("mockConfig", () => {
  test("overrides are visible inside fn and restored after", async () => {
    const config = loadConfig();

    expect(config.app.port).toBe(3000);
    await mockConfig<AppConfig, void>({ app: { port: 8080 } }, async () => {
      expect(config.app.port).toBe(8080);
      expect(config.app.name).toBe("forge");
    });
    expect(config.app.port).toBe(3000);
  });

  test("nested mocks compose with last write wins", async () => {
    const config = loadConfig();

    await mockConfig<AppConfig, void>({ app: { port: 8080 } }, async () => {
      expect(config.app.port).toBe(8080);
      await mockConfig<AppConfig, void>(
        { app: { name: "nested" }, features: { maintenanceMode: true } },
        async () => {
          expect(config.app.port).toBe(8080);
          expect(config.app.name).toBe("nested");
          expect(config.features.maintenanceMode).toBe(true);
        },
      );
      expect(config.app.port).toBe(8080);
      expect(config.app.name).toBe("forge");
      expect(config.features.maintenanceMode).toBe(false);
    });
  });

  test("exceptions still pop the override scope", async () => {
    const config = loadConfig();

    await expect(
      mockConfig<AppConfig, void>({ app: { port: 9090 } }, async () => {
        expect(config.app.port).toBe(9090);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(config.app.port).toBe(3000);
  });

  test("parallel async scopes do not bleed into each other", async () => {
    const config = loadConfig();

    const [first, second] = await Promise.all([
      mockConfig<AppConfig, number>({ app: { port: 1111 } }, async () => {
        await Bun.sleep(5);
        return config.app.port;
      }),
      mockConfig<AppConfig, number>({ app: { port: 2222 } }, async () => {
        await Bun.sleep(1);
        return config.app.port;
      }),
    ]);

    expect(first).toBe(1111);
    expect(second).toBe(2222);
    expect(config.app.port).toBe(3000);
  });

  test("mockable configs preserve the deep-freeze contract", () => {
    "use strict";
    const config = loadConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
    expect(() => {
      (config.app as { port: number }).port = 1234;
    }).toThrow(TypeError);
  });
});
