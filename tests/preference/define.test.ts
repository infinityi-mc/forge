import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  PreferenceSchemaError,
  t,
  type PreferenceDiagnostic,
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

describe("definePreferences", () => {
  test("loads defaults and optionals from an empty memory store", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const prefs = await definePreferences(schema, {
      store: memoryStore(),
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(prefs.values.editor.autosave).toBe(true);
    expect(prefs.values.editor.recentFiles).toEqual([]);
    expect(prefs.values.editor.workspaceName).toBeUndefined();
    expect(prefs.diagnostics).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test("valid explicit JSON-native values override defaults", async () => {
    const prefs = await definePreferences(schema, {
      store: memoryStore({
        "appearance.theme": "dark",
        "appearance.fontSize": 18,
        "editor.autosave": false,
        "editor.recentFiles": ["a.ts", "b.ts"],
        "editor.workspaceName": "forge",
      }),
    });

    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.appearance.fontSize).toBe(18);
    expect(prefs.values.editor.autosave).toBe(false);
    expect(prefs.values.editor.recentFiles).toEqual(["a.ts", "b.ts"]);
    expect(prefs.values.editor.workspaceName).toBe("forge");
  });

  test("also accepts string snapshots where the shared parsers already support them", async () => {
    const prefs = await definePreferences(schema, {
      store: memoryStore({
        "appearance.fontSize": "20",
        "editor.autosave": "no",
        "editor.recentFiles": '["from-string.ts"]',
      }),
    });

    expect(prefs.values.appearance.fontSize).toBe(20);
    expect(prefs.values.editor.autosave).toBe(false);
    expect(prefs.values.editor.recentFiles).toEqual(["from-string.ts"]);
  });

  test("invalid leaves fall back independently and emit diagnostics", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const prefs = await definePreferences(schema, {
      store: memoryStore({
        "appearance.theme": "neon",
        "appearance.fontSize": 16,
        "editor.recentFiles": [1],
      }),
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(16);
    expect(prefs.values.editor.recentFiles).toEqual([]);
    expect(diagnostics.map((d) => d.path)).toEqual([
      "appearance.theme",
      "editor.recentFiles",
    ]);
    expect(diagnostics.every((d) => d.status === "invalid")).toBe(true);
    expect(diagnostics[0]!.received).toBe("neon");
  });

  test("unknown explicit keys are ignored", async () => {
    const prefs = await definePreferences(schema, {
      store: memoryStore({
        "appearance.theme": "light",
        "unknown.key": "preserved-for-future-prs",
      }),
    });

    expect(prefs.values.appearance.theme).toBe("light");
    expect(prefs.diagnostics).toEqual([]);
  });

  test("store load undefined is treated as first run", async () => {
    const store: PreferenceStore = {
      name: "first-run",
      load: async () => undefined,
      save: async () => {},
    };

    const prefs = await definePreferences(schema, { store });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.diagnostics).toEqual([]);
  });

  test("store load failures fall back to defaults and emit non-fatal diagnostics", async () => {
    const received: PreferenceDiagnostic[] = [];
    const store: PreferenceStore = {
      name: "broken",
      load: async () => {
        throw new Error("disk disappeared");
      },
      save: async () => {},
    };

    const prefs = await definePreferences(schema, {
      store,
      onDiagnostic: (diagnostic) => {
        received.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.diagnostics).toHaveLength(1);
    expect(prefs.diagnostics[0]).toMatchObject({
      status: "store_error",
      store: "broken",
    });
    expect(prefs.diagnostics[0]!.reason).toContain("disk disappeared");
    expect(received).toEqual([...prefs.diagnostics]);
  });

  test("non-object store snapshots fall back to defaults with diagnostics", async () => {
    const received: PreferenceDiagnostic[] = [];
    const store: PreferenceStore = {
      name: "bad-shape",
      load: async () => null as never,
      save: async () => {},
    };

    const prefs = await definePreferences(schema, {
      store,
      onDiagnostic: (diagnostic) => {
        received.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.diagnostics).toHaveLength(1);
    expect(prefs.diagnostics[0]).toMatchObject({
      status: "store_error",
      store: "bad-shape",
      received: null,
    });
    expect(prefs.diagnostics[0]!.reason).toContain("non-object snapshot");
    expect(received).toEqual([...prefs.diagnostics]);
  });

  test("onDiagnostic failures are isolated", async () => {
    const prefs = await definePreferences(schema, {
      store: memoryStore({ "appearance.theme": "neon" }),
      onDiagnostic: () => {
        throw new Error("observer failed");
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.diagnostics).toHaveLength(1);
  });

  test("values are exposed through a reflective read-only proxy over a frozen tree", async () => {
    const prefs = await definePreferences(schema, {
      store: memoryStore({ "appearance.theme": "dark" }),
    });

    expect(Object.keys(prefs.values)).toEqual(["appearance", "editor"]);
    const desc = Object.getOwnPropertyDescriptor(prefs.values, "appearance");
    expect(desc).toBeDefined();
    expect(desc!.configurable).toBe(true);
    expect(Object.isFrozen(prefs.values.appearance)).toBe(true);
    expect(() => {
      (prefs.values as { appearance: unknown }).appearance = {};
    }).toThrow(TypeError);
    expect(() => {
      (prefs.values.appearance as { theme: string }).theme = "light";
    }).toThrow(TypeError);
  });

  test("schema leaves must declare a default or optional fallback", async () => {
    await expect(
      definePreferences(
        {
          appearance: {
            theme: t.enum(["light", "dark"] as const) as never,
          },
        },
        { store: memoryStore() },
      ),
    ).rejects.toBeInstanceOf(PreferenceSchemaError);
  });
});
