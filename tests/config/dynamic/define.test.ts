import { describe, expect, test } from "bun:test";
import { defineDynamicConfig } from "../../../src/config/dynamic/define";
import { staticProvider } from "../../../src/config/providers/static";
import type {
  DynamicConfigProvider,
  DynamicSnapshotHandler,
} from "../../../src/config/providers/types";
import { t } from "../../../src/config/schema/builder";
import { ConfigValidationError } from "../../../src/config/errors";

/**
 * Tiny manual provider that lets a test drive snapshot updates
 * deterministically. Avoids `setTimeout`-based races inside the
 * `defineDynamicConfig` tests — the polling-loop behaviour is
 * covered by the dedicated `pollingProvider` tests.
 */
function controllableProvider(
  initial: Record<string, string>,
  name = "controllable",
): DynamicConfigProvider & {
  push(next: Record<string, string>): void;
  subscriberCount(): number;
} {
  const handlers = new Set<DynamicSnapshotHandler>();
  let current = initial;
  return {
    name,
    get: () => current,
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    push(next) {
      current = next;
      for (const h of handlers) h(next);
    },
    subscriberCount() {
      return handlers.size;
    },
  };
}

describe("defineDynamicConfig", () => {
  test("validates the initial snapshot and exposes typed values via the proxy", async () => {
    const handle = await defineDynamicConfig(
      {
        features: {
          newCheckout: t.boolean.default(false),
          maintenanceMode: t.boolean.default(false),
        },
        limits: { maxUploadSizeMb: t.number.default(10) },
      },
      {
        provider: staticProvider({
          "features.newCheckout": "true",
          "limits.maxUploadSizeMb": "25",
        }),
      },
    );
    expect(handle.values.features.newCheckout).toBe(true);
    expect(handle.values.features.maintenanceMode).toBe(false);
    expect(handle.values.limits.maxUploadSizeMb).toBe(25);
    await handle.shutdown();
  });

  test("throws ConfigValidationError when the initial snapshot is invalid", async () => {
    const promise = defineDynamicConfig(
      {
        features: { ratio: t.number.required() },
      },
      {
        provider: staticProvider({
          "features.ratio": "not-a-number",
        }),
      },
    );
    await expect(promise).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test("redacts received values from dynamic diagnostics by default", async () => {
    try {
      await defineDynamicConfig(
        {
          features: { ratio: t.number.required() },
        },
        {
          provider: staticProvider({
            "features.ratio": "not-a-number",
          }),
        },
      );
      throw new Error("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues[0]!.received).toBeUndefined();
      expect(issues[0]!.reason).not.toContain("not-a-number");
    }
  });

  test("redactReceived=false includes received values in dynamic diagnostics", async () => {
    try {
      await defineDynamicConfig(
        {
          features: { ratio: t.number.required() },
        },
        {
          provider: staticProvider({
            "features.ratio": "not-a-number",
          }),
          redactReceived: false,
        },
      );
      throw new Error("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues[0]!.received).toBe("not-a-number");
    }
  });

  test("atomically swaps the live view when the provider pushes a valid update", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
    });
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      { provider },
    );
    expect(handle.values.features.maintenanceMode).toBe(false);

    provider.push({ "features.maintenanceMode": "true" });

    // Proxy reads the latest snapshot — no re-call required.
    expect(handle.values.features.maintenanceMode).toBe(true);
    await handle.shutdown();
  });

  test("invokes onChange with the previous + new tree and the changed dotted paths", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
      "limits.maxUploadSizeMb": "10",
    });
    let received:
      | { oldVal: unknown; newVal: unknown; keys: readonly string[] }
      | undefined;
    const handle = await defineDynamicConfig(
      {
        features: { maintenanceMode: t.boolean.default(false) },
        limits: { maxUploadSizeMb: t.number.default(10) },
      },
      {
        provider,
        onChange: (oldVal, newVal, keys) => {
          received = { oldVal, newVal, keys };
        },
      },
    );

    provider.push({
      "features.maintenanceMode": "true",
      "limits.maxUploadSizeMb": "10",
    });

    expect(received).toBeDefined();
    expect(received!.keys).toEqual(["features.maintenanceMode"]);
    expect(
      (received!.oldVal as { features: { maintenanceMode: boolean } }).features
        .maintenanceMode,
    ).toBe(false);
    expect(
      (received!.newVal as { features: { maintenanceMode: boolean } }).features
        .maintenanceMode,
    ).toBe(true);
    await handle.shutdown();
  });

  test("skips onChange and the live-view swap when an update has no diff", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
    });
    let onChangeCalls = 0;
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      {
        provider,
        onChange: () => {
          onChangeCalls += 1;
        },
      },
    );
    provider.push({ "features.maintenanceMode": "false" });
    provider.push({ "features.maintenanceMode": "false" });
    expect(onChangeCalls).toBe(0);
    await handle.shutdown();
  });

  test("isolates onChange throws by default; logger receives an error line", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
    });
    const lines: { level: string; msg: string; attrs?: unknown }[] = [];
    const logger = {
      info: (msg: string, attrs?: unknown) =>
        lines.push({ level: "info", msg, attrs }),
      warn: (msg: string, attrs?: unknown) =>
        lines.push({ level: "warn", msg, attrs }),
      error: (msg: string, attrs?: unknown) =>
        lines.push({ level: "error", msg, attrs }),
    };
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      {
        provider,
        logger,
        onChange: () => {
          throw new Error("boom");
        },
      },
    );

    provider.push({ "features.maintenanceMode": "true" });

    // Live view still swapped; we don't poison it on `onChange` throw.
    expect(handle.values.features.maintenanceMode).toBe(true);
    const errLine = lines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toBe("Dynamic config provider error");
    expect((errLine!.attrs as { phase: string }).phase).toBe("on-change");
    await handle.shutdown();
  });

  test("when propagateProviderErrors=true, an onChange throw resurfaces from the next shutdown()", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
    });
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      {
        provider,
        propagateProviderErrors: true,
        onChange: () => {
          throw new Error("boom");
        },
      },
    );
    provider.push({ "features.maintenanceMode": "true" });
    await expect(handle.shutdown()).rejects.toMatchObject({
      name: "ConfigProviderError",
      phase: "on-change",
      provider: "controllable",
    });
  });

  test("an invalid update preserves the previous valid snapshot and surfaces an error", async () => {
    const provider = controllableProvider({
      "limits.ratio": "0.5",
    });
    const lines: { level: string; msg: string; attrs?: unknown }[] = [];
    const logger = {
      info: (msg: string, attrs?: unknown) =>
        lines.push({ level: "info", msg, attrs }),
      warn: (msg: string, attrs?: unknown) =>
        lines.push({ level: "warn", msg, attrs }),
      error: (msg: string, attrs?: unknown) =>
        lines.push({ level: "error", msg, attrs }),
    };
    const handle = await defineDynamicConfig(
      { limits: { ratio: t.number.required() } },
      { provider, logger },
    );
    expect(handle.values.limits.ratio).toBe(0.5);

    provider.push({ "limits.ratio": "not-a-number" });

    // Live view unchanged.
    expect(handle.values.limits.ratio).toBe(0.5);
    const errLine = lines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect((errLine!.attrs as { phase: string }).phase).toBe("update");
    await handle.shutdown();
  });

  test("shutdown() unsubscribes and is safe to call twice", async () => {
    const provider = controllableProvider({});
    const handle = await defineDynamicConfig({} as Record<string, never>, {
      provider,
    });
    expect(provider.subscriberCount()).toBe(1);
    await handle.shutdown();
    expect(provider.subscriberCount()).toBe(0);
    // Second call is a no-op.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  test("propagateProviderErrors=true: provider.shutdown() throw resurfaces with phase 'shutdown'", async () => {
    const failing: DynamicConfigProvider = {
      name: "fails-on-shutdown",
      get: () => ({}),
      subscribe: () => () => {},
      shutdown: async () => {
        throw new Error("teardown went sideways");
      },
    };
    const handle = await defineDynamicConfig({} as Record<string, never>, {
      provider: failing,
      propagateProviderErrors: true,
    });
    await expect(handle.shutdown()).rejects.toMatchObject({
      name: "ConfigProviderError",
      provider: "fails-on-shutdown",
      phase: "shutdown",
    });
  });

  test("propagateProviderErrors=true: provider.flush() throw resurfaces with phase 'flush'", async () => {
    const failing: DynamicConfigProvider = {
      name: "fails-on-flush",
      get: () => ({}),
      subscribe: () => () => {},
      flush: async () => {
        throw new Error("flush exploded");
      },
    };
    const handle = await defineDynamicConfig({} as Record<string, never>, {
      provider: failing,
      propagateProviderErrors: true,
    });
    await expect(handle.flush()).rejects.toMatchObject({
      name: "ConfigProviderError",
      provider: "fails-on-flush",
      phase: "flush",
    });
    // Calling shutdown after a deferred flush error still re-throws
    // the first-seen error (we don't try to be cute and de-dup), but
    // it doesn't crash.
    await expect(handle.shutdown()).rejects.toMatchObject({
      phase: "flush",
    });
  });

  test("logger receives the correct phase label on shutdown/flush failures (isolated mode)", async () => {
    const failing: DynamicConfigProvider = {
      name: "noisy",
      get: () => ({}),
      subscribe: () => () => {},
      shutdown: async () => {
        throw new Error("teardown");
      },
      flush: async () => {
        throw new Error("flush");
      },
    };
    const lines: { level: string; msg: string; attrs?: unknown }[] = [];
    const logger = {
      info: (msg: string, attrs?: unknown) =>
        lines.push({ level: "info", msg, attrs }),
      warn: (msg: string, attrs?: unknown) =>
        lines.push({ level: "warn", msg, attrs }),
      error: (msg: string, attrs?: unknown) =>
        lines.push({ level: "error", msg, attrs }),
    };
    const handle = await defineDynamicConfig({} as Record<string, never>, {
      provider: failing,
      logger,
    });
    await handle.flush();
    await handle.shutdown();
    const phases = lines
      .filter((l) => l.level === "error")
      .map((l) => (l.attrs as { phase: string }).phase);
    expect(phases).toEqual(["flush", "shutdown"]);
  });

  test("[Symbol.asyncDispose] aliases shutdown()", async () => {
    const provider = controllableProvider({});
    const handle = await defineDynamicConfig({} as Record<string, never>, {
      provider,
    });
    expect(provider.subscriberCount()).toBe(1);
    await handle[Symbol.asyncDispose]();
    expect(provider.subscriberCount()).toBe(0);
  });

  test("Proxy reads always return the latest snapshot; nested-subtree capture pins to the access-time snapshot", async () => {
    const provider = controllableProvider({
      "features.maintenanceMode": "false",
    });
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      { provider },
    );

    // Capture the subtree at snapshot v1.
    const pinned = handle.values.features;
    provider.push({ "features.maintenanceMode": "true" });

    // Top-level access sees the swap.
    expect(handle.values.features.maintenanceMode).toBe(true);
    // The pinned subtree is the v1 frozen object — documented behaviour.
    expect(pinned.maintenanceMode).toBe(false);
    await handle.shutdown();
  });

  test("Proxy supports reflective descriptor and key operations", async () => {
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      { provider: staticProvider({ "features.maintenanceMode": "true" }) },
    );

    const desc = Object.getOwnPropertyDescriptor(handle.values, "features");
    expect(desc).toBeDefined();
    expect(desc!.configurable).toBe(true);
    expect(desc!.enumerable).toBe(true);
    expect(
      Object.getOwnPropertyDescriptors(handle.values).features,
    ).toBeDefined();
    expect(Object.keys(handle.values)).toEqual(["features"]);
    await handle.shutdown();
  });

  test("Proxy rejects mutations on the live view", async () => {
    const provider = controllableProvider({});
    const handle = await defineDynamicConfig(
      { features: { maintenanceMode: t.boolean.default(false) } },
      { provider },
    );
    expect(() => {
      (handle.values as { features: { maintenanceMode: boolean } }).features = {
        maintenanceMode: true,
      };
    }).toThrow(TypeError);
    await handle.shutdown();
  });
});
