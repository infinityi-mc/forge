import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  PreferenceSchemaError,
  t,
  type PreferenceDiagnostic,
} from "../../src/preference";

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
  },
  editor: {
    autosave: t.boolean.default(true),
  },
};

describe("definePreferences versioning", () => {
  test("runs ordered migrations, persists current version, and preserves unknown keys", async () => {
    const store = memoryStore({
      $version: 1,
      "appearance.theme": "dark",
      "editor.autoSave": false,
      "future.flag": true,
    });
    const prefs = await definePreferences(schema, {
      store,
      version: 3,
      migrations: {
        2: (raw) => ({
          ...raw,
          "editor.autosave": raw["editor.autoSave"] ?? raw["editor.autosave"],
        }),
        3: (raw) => ({ ...raw, "migration.three": "kept" }),
      },
    });

    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.editor.autosave).toBe(false);

    await prefs.set("appearance.theme", "light");

    expect(store.snapshot()).toEqual({
      $version: 3,
      "appearance.theme": "light",
      "editor.autosave": false,
      "editor.autoSave": false,
      "future.flag": true,
      "migration.three": "kept",
    });
  });

  test("failed migrations fall back to defaults with diagnostics", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const store = memoryStore({
      $version: 1,
      "appearance.theme": "dark",
      "future.flag": true,
    });

    const prefs = await definePreferences(schema, {
      store,
      version: 2,
      migrations: {
        2: () => {
          throw new Error("cannot migrate old theme");
        },
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.editor.autosave).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      status: "migration_error",
      version: 2,
    });
    expect(diagnostics[0]!.reason).toContain("cannot migrate old theme");

    await prefs.set("editor.autosave", false);

    expect(store.snapshot()).toEqual({
      $version: 2,
      "editor.autosave": false,
      "future.flag": true,
    });
  });

  test("future persisted versions are preserved without running older migrations", async () => {
    const store = memoryStore({
      $version: 9,
      "appearance.theme": "dark",
      "future.flag": true,
    });
    const prefs = await definePreferences(schema, {
      store,
      version: 2,
      migrations: {
        2: () => {
          throw new Error("should not run");
        },
      },
    });

    expect(prefs.values.appearance.theme).toBe("dark");

    await prefs.set("editor.autosave", false);

    expect(store.snapshot()).toEqual({
      $version: 9,
      "appearance.theme": "dark",
      "editor.autosave": false,
      "future.flag": true,
    });
  });

  test("invalid migrated leaves fall back while unknown keys survive later saves", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const store = memoryStore({
      $version: 1,
      "appearance.theme": "light",
      "future.flag": true,
    });

    const prefs = await definePreferences(schema, {
      store,
      version: 2,
      migrations: {
        2: (raw) => ({ ...raw, "appearance.theme": "neon" }),
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "appearance.theme",
    ]);

    await prefs.set("editor.autosave", false);

    expect(store.snapshot()).toEqual({
      $version: 2,
      "editor.autosave": false,
      "future.flag": true,
    });
  });

  test("invalid persisted version metadata is fail-safe", async () => {
    const diagnostics: PreferenceDiagnostic[] = [];
    const store = memoryStore({
      $version: "two",
      "appearance.theme": "dark",
      "future.flag": true,
    });

    const prefs = await definePreferences(schema, {
      store,
      version: 2,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(diagnostics[0]).toMatchObject({
      status: "migration_error",
      path: "$version",
      version: 2,
      received: "two",
    });
  });

  test("$version is reserved for metadata", async () => {
    await expect(
      definePreferences(
        {
          $version: t.number.default(1),
        },
        { store: memoryStore() },
      ),
    ).rejects.toBeInstanceOf(PreferenceSchemaError);
  });
});
