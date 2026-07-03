import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  PreferenceValidationError,
  t,
} from "../../src/preference";

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.int.default(14),
  },
  editor: {
    autosave: t.boolean.default(true),
  },
};

describe("definePreferences scopes", () => {
  test("later scopes win and unscoped writes target the highest-precedence scope", async () => {
    const user = memoryStore(
      {
        "appearance.theme": "light",
        "editor.autosave": false,
        "user.future": true,
      },
      { name: "user-store" },
    );
    const workspace = memoryStore(
      {
        "appearance.theme": "dark",
        "workspace.future": true,
      },
      { name: "workspace-store" },
    );
    const prefs = await definePreferences(schema, {
      scopes: { user, workspace },
      version: 2,
    });

    expect(prefs.values.appearance.theme).toBe("dark");
    expect(prefs.values.editor.autosave).toBe(false);
    expect(prefs.isSet("appearance.theme")).toBe(true);
    expect(prefs.isSet("appearance.theme", { scope: "user" })).toBe(true);
    expect(prefs.isSet("appearance.theme", { scope: "workspace" })).toBe(true);

    await prefs.set("appearance.fontSize", 18);

    expect(user.snapshot()).toEqual({
      "editor.autosave": false,
      "appearance.theme": "light",
      "user.future": true,
    });
    expect(workspace.snapshot()).toEqual({
      $version: 2,
      "appearance.fontSize": 18,
      "appearance.theme": "dark",
      "workspace.future": true,
    });

    await prefs.set("appearance.theme", "system", { scope: "user" });
    expect(prefs.values.appearance.theme).toBe("dark");
    expect(user.snapshot()).toEqual({
      $version: 2,
      "appearance.theme": "system",
      "editor.autosave": false,
      "user.future": true,
    });

    await prefs.reset("appearance.theme", { scope: "workspace" });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.isSet("appearance.theme")).toBe(true);
    expect(prefs.isSet("appearance.theme", { scope: "workspace" })).toBe(false);
    expect(workspace.snapshot()).toEqual({
      $version: 2,
      "appearance.fontSize": 18,
      "workspace.future": true,
    });

    await prefs.reset("appearance.theme", { scope: "user" });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.isSet("appearance.theme")).toBe(false);
  });

  test("merged subscriptions only fire for effective value changes", async () => {
    const user = memoryStore({ "appearance.theme": "light" });
    const workspace = memoryStore();
    const prefs = await definePreferences(schema, {
      scopes: { user, workspace },
    });
    const changed: Array<readonly string[]> = [];
    prefs.subscribe((_oldValues, _nextValues, changedKeys) => {
      changed.push(changedKeys);
    });

    await prefs.set("appearance.theme", "dark", { scope: "user" });
    await prefs.set("appearance.theme", "system", { scope: "workspace" });
    await prefs.set("appearance.theme", "light", { scope: "user" });

    expect(changed).toEqual([
      ["appearance.theme"],
      ["appearance.theme"],
    ]);
    expect(prefs.values.appearance.theme).toBe("system");
  });

  test("external scoped snapshots are reloaded independently", async () => {
    const user = memoryStore({ "appearance.theme": "light" });
    const workspace = memoryStore();
    const prefs = await definePreferences(schema, {
      scopes: { user, workspace },
    });

    workspace.replace({ "appearance.theme": "dark" });
    await prefs.flush();
    expect(prefs.values.appearance.theme).toBe("dark");

    user.replace({ "appearance.theme": "system" });
    await prefs.flush();
    expect(prefs.values.appearance.theme).toBe("dark");

    workspace.replace({});
    await prefs.flush();
    expect(prefs.values.appearance.theme).toBe("system");
  });

  test("resetAll clears only the target scope", async () => {
    const user = memoryStore({ "editor.autosave": false });
    const workspace = memoryStore({
      "appearance.theme": "dark",
      "appearance.fontSize": 18,
    });
    const prefs = await definePreferences(schema, {
      scopes: { user, workspace },
    });

    await prefs.resetAll({ scope: "workspace" });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(14);
    expect(prefs.values.editor.autosave).toBe(false);
    expect(user.snapshot()).toEqual({ "editor.autosave": false });
    expect(workspace.snapshot()).toEqual({});
  });

  test("unknown scopes are rejected on caller write APIs", async () => {
    const prefs = await definePreferences(schema, {
      scopes: { user: memoryStore(), workspace: memoryStore() },
    });

    await expect(
      prefs.set("appearance.theme", "dark", { scope: "machine" as never }),
    ).rejects.toBeInstanceOf(PreferenceValidationError);
    expect(() =>
      prefs.isSet("appearance.theme", { scope: "machine" as never }),
    ).toThrow(PreferenceValidationError);
  });
});
