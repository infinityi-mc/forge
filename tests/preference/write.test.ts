import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  PreferenceStoreError,
  PreferenceValidationError,
  t,
  type PreferenceDiagnostic,
  type PreferenceSnapshot,
  type PreferenceSnapshotHandler,
  type PreferenceStore,
} from "../../src/preference";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.int.default(14),
  },
  editor: {
    autosave: t.boolean.default(true),
    recentFiles: t
      .json<readonly string[]>()
      .validate(isStringArray, "Expected an array of strings.")
      .default([]),
    workspaceName: t.string.optional(),
  },
};

describe("definePreferences write path", () => {
  test("set updates the live proxy and persists explicit values only", async () => {
    const store = memoryStore();
    const prefs = await definePreferences(schema, { store });

    await prefs.set("appearance.theme", "dark");

    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(prefs.isSet("appearance.theme")).toBe(true);
    expect(prefs.isSet("appearance.fontSize")).toBe(false);
    expect(store.snapshot()).toEqual({ "appearance.theme": "dark" });

    await prefs.set("appearance.theme", "system");

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.isSet("appearance.theme")).toBe(true);
    expect(store.snapshot()).toEqual({ "appearance.theme": "system" });
  });

  test("concurrent writes merge against the latest explicit snapshot", async () => {
    const firstSaveStarted = deferred<void>();
    const releaseFirstSave = deferred<void>();
    let current: PreferenceSnapshot = {};
    let saveCalls = 0;
    const store: PreferenceStore = {
      name: "delayed-save",
      load: async () => current,
      async save(snapshot) {
        saveCalls += 1;
        if (saveCalls === 1) {
          firstSaveStarted.resolve();
          await releaseFirstSave.promise;
        }
        current = structuredClone(snapshot) as PreferenceSnapshot;
      },
    };
    const prefs = await definePreferences(schema, { store });

    const first = prefs.set("appearance.theme", "dark");
    await firstSaveStarted.promise;
    const second = prefs.set("appearance.fontSize", 18);
    await Promise.resolve();

    releaseFirstSave.resolve();
    await Promise.all([first, second]);

    expect(current).toEqual({
      "appearance.theme": "dark",
      "appearance.fontSize": 18,
    });
    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.appearance.fontSize).toBe(18);
  });

  test("external snapshots are serialized with in-flight writes", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    let external: PreferenceSnapshotHandler | undefined;
    let saved = false;
    const store: PreferenceStore = {
      name: "external-race",
      load: async () => ({}),
      async save(_snapshot) {
        if (!saved) {
          saved = true;
          saveStarted.resolve();
          await releaseSave.promise;
        }
      },
      watch(handler) {
        external = handler;
        return () => {};
      },
      async flush() {},
    };
    const prefs = await definePreferences(schema, { store });

    const localWrite = prefs.set("appearance.theme", "dark");
    await saveStarted.promise;
    external?.({ "appearance.fontSize": 18 } satisfies PreferenceSnapshot);

    releaseSave.resolve();
    await localWrite;
    await prefs.flush();

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(18);
    expect(prefs.isSet("appearance.theme")).toBe(false);
    expect(prefs.isSet("appearance.fontSize")).toBe(true);
  });

  test("subscriber changed keys stay at schema leaf paths for JSON object leaves", async () => {
    const objectSchema = {
      settings: t.json<{ readonly theme: string }>().default({ theme: "light" }),
    };
    const prefs = await definePreferences(objectSchema, { store: memoryStore() });
    const changed: Array<readonly string[]> = [];
    prefs.subscribe((_oldValues, _nextValues, changedKeys) => {
      changed.push(changedKeys);
    });

    await prefs.set("settings", { theme: "dark" });

    expect(changed).toEqual([["settings"]]);
  });

  test("writes are rejected after shutdown starts", async () => {
    const store = memoryStore();
    const prefs = await definePreferences(schema, { store });

    await prefs.shutdown();

    await expect(prefs.set("appearance.theme", "dark")).rejects.toBeInstanceOf(
      PreferenceStoreError,
    );
    await expect(
      prefs.update(() => ({ appearance: { theme: "dark" } })),
    ).rejects.toBeInstanceOf(PreferenceStoreError);
    await expect(prefs.reset("appearance.theme")).rejects.toBeInstanceOf(
      PreferenceStoreError,
    );
    await expect(prefs.resetAll()).rejects.toBeInstanceOf(PreferenceStoreError);
    expect(store.snapshot()).toEqual({});
  });

  test("set rejects invalid paths and values without saving", async () => {
    const store = memoryStore();
    const prefs = await definePreferences(schema, { store });

    await expect(
      prefs.set("appearance.theme", "neon" as never),
    ).rejects.toBeInstanceOf(PreferenceValidationError);
    await expect(
      prefs.set("appearance.missing" as never, "dark" as never),
    ).rejects.toBeInstanceOf(PreferenceValidationError);
    await expect(
      prefs.set("editor.workspaceName", undefined as never),
    ).rejects.toBeInstanceOf(PreferenceValidationError);

    expect(prefs.values.appearance.theme).toBe("system");
    expect(store.snapshot()).toEqual({});
  });

  test("store save failures leave live values and explicit state unchanged", async () => {
    const store: PreferenceStore = {
      name: "broken-save",
      load: async () => ({ "appearance.theme": "light" }),
      save: async () => {
        throw new Error("disk full");
      },
    };
    const prefs = await definePreferences(schema, { store });

    await expect(prefs.set("appearance.theme", "dark")).rejects.toBeInstanceOf(
      PreferenceStoreError,
    );

    expect(prefs.values.appearance.theme).toBe("light");
    expect(prefs.isSet("appearance.theme")).toBe(true);
  });

  test("update applies a nested partial patch atomically", async () => {
    const store = memoryStore({ "appearance.theme": "light" });
    const prefs = await definePreferences(schema, { store });

    await prefs.update((values) => ({
      appearance: { fontSize: values.appearance.fontSize + 2 },
      editor: { recentFiles: [...values.editor.recentFiles, "a.ts"] },
    }));

    expect(prefs.values.appearance.theme).toBe("light");
    expect(prefs.values.appearance.fontSize).toBe(16);
    expect(prefs.values.editor.recentFiles).toEqual(["a.ts"]);
    expect(store.snapshot()).toEqual({
      "appearance.theme": "light",
      "appearance.fontSize": 16,
      "editor.recentFiles": ["a.ts"],
    });
  });

  test("invalid update patches do not partially save", async () => {
    const store = memoryStore({ "appearance.theme": "light" });
    const prefs = await definePreferences(schema, { store });

    await expect(
      prefs.update(() => ({
        appearance: {
          theme: "dark",
          fontSize: "big" as never,
        },
      })),
    ).rejects.toBeInstanceOf(PreferenceValidationError);

    expect(prefs.values.appearance.theme).toBe("light");
    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(store.snapshot()).toEqual({ "appearance.theme": "light" });
  });

  test("reset and resetAll delete explicit values", async () => {
    const store = memoryStore({
      "appearance.theme": "dark",
      "appearance.fontSize": 18,
      "editor.workspaceName": "forge",
    });
    const prefs = await definePreferences(schema, { store });

    await prefs.reset("appearance.theme");

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(18);
    expect(prefs.isSet("appearance.theme")).toBe(false);
    expect(store.snapshot()).toEqual({
      "appearance.fontSize": 18,
      "editor.workspaceName": "forge",
    });

    await prefs.resetAll();

    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(prefs.values.editor.workspaceName).toBeUndefined();
    expect(prefs.isSet("appearance.fontSize")).toBe(false);
    expect(store.snapshot()).toEqual({});
  });

  test("subscribe receives effective changes and isolates handler failures", async () => {
    const store = memoryStore();
    const prefs = await definePreferences(schema, { store });
    const events: { oldTheme: string; nextTheme: string; keys: readonly string[] }[] = [];

    prefs.subscribe(() => {
      throw new Error("observer failed");
    });
    const unsubscribe = prefs.subscribe((oldValues, nextValues, changedKeys) => {
      events.push({
        oldTheme: oldValues.appearance.theme,
        nextTheme: nextValues.appearance.theme,
        keys: changedKeys,
      });
    });

    await prefs.set("appearance.theme", "system");
    await prefs.set("appearance.theme", "dark");
    unsubscribe();
    await prefs.set("appearance.theme", "light");

    expect(events).toEqual([
      {
        oldTheme: "system",
        nextTheme: "dark",
        keys: ["appearance.theme"],
      },
    ]);
  });

  test("external watch snapshots update the live view fail-safely", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const store = memoryStore({ "appearance.theme": "light" });
    const prefs = await definePreferences(schema, {
      store,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    const changed: Array<readonly string[]> = [];
    prefs.subscribe((_oldValues, _nextValues, changedKeys) => {
      changed.push(changedKeys);
    });

    store.replace({
      "appearance.theme": "dark",
      "appearance.fontSize": "huge",
      "unknown.future": true,
    });
    await prefs.flush();

    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(prefs.isSet("appearance.theme")).toBe(true);
    expect(prefs.isSet("appearance.fontSize")).toBe(false);
    expect(diagnostics.map((d) => d.path)).toEqual(["appearance.fontSize"]);
    expect(changed).toEqual([["appearance.theme"]]);

    await prefs.set("editor.autosave", false);

    expect(store.snapshot()).toEqual({
      "appearance.theme": "dark",
      "editor.autosave": false,
      "unknown.future": true,
    });
  });

  test("external non-object snapshots fall back safely", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const store = memoryStore({ "appearance.theme": "light" });
    const prefs = await definePreferences(schema, {
      store,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    store.replace(null as never);
    await prefs.flush();

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.isSet("appearance.theme")).toBe(false);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        status: "store_error",
        store: "memory",
        received: null,
      }),
    );
  });

  test("flush, shutdown, and async dispose delegate to the store idempotently", async () => {
    let flushes = 0;
    let shutdowns = 0;
    let unsubscriptions = 0;
    let external: PreferenceSnapshotHandler | undefined;
    const store: PreferenceStore = {
      name: "lifecycle",
      load: async () => ({}),
      save: async () => {},
      watch(handler) {
        external = handler;
        return () => {
          unsubscriptions += 1;
        };
      },
      async flush() {
        flushes += 1;
      },
      async shutdown() {
        shutdowns += 1;
      },
    };
    const prefs = await definePreferences(schema, { store });
    let calls = 0;
    prefs.subscribe(() => {
      calls += 1;
    });

    await prefs.shutdown();
    external?.({ "appearance.theme": "dark" } satisfies PreferenceSnapshot);
    await prefs[Symbol.asyncDispose]();

    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
    expect(unsubscriptions).toBe(1);
    expect(calls).toBe(0);
  });

  test("URL-secret diagnostics mention every accepted raw input type", async () => {
    const prefs = await definePreferences(
      {
        endpoint: t.url.default(new URL("https://example.com")).secret(),
      },
      { store: memoryStore() },
    );

    try {
      await prefs.set("endpoint", { href: "https://example.com" } as never);
      throw new Error("expected PreferenceValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PreferenceValidationError);
      expect((error as PreferenceValidationError).diagnostics[0]!.reason).toBe(
        "Expected secret URL preference value to be a string or URL.",
      );
    }
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
