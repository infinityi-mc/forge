import { describe, expect, test } from "bun:test";
import {
  definePreferences,
  memoryStore,
  t,
  type PreferenceValues,
} from "../../../src/preference";
import { mockPreferences } from "../../../src/preference/testing";

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.int.default(14),
  },
  editor: {
    autosave: t.boolean.default(true),
    recentFiles: t.json<readonly string[]>().default([]),
  },
};

type AppPreferences = PreferenceValues<typeof schema>;

describe("mockPreferences", () => {
  test("overrides values inside fn without mutating the store", async () => {
    const store = memoryStore({ "appearance.fontSize": 18 });
    const prefs = await definePreferences(schema, { store });

    expect(prefs.values.appearance.theme).toBe("system");
    expect(prefs.values.appearance.fontSize).toBe(18);

    await mockPreferences<AppPreferences, void>(
      { appearance: { theme: "dark" } },
      async () => {
        expect(prefs.values.appearance.theme).toBe("dark");
        expect(prefs.values.appearance.fontSize).toBe(18);
        expect(store.snapshot()).toEqual({ "appearance.fontSize": 18 });
      },
    );

    expect(prefs.values.appearance.theme).toBe("system");
    expect(store.snapshot()).toEqual({ "appearance.fontSize": 18 });
  });

  test("nested mocks compose with last write wins", async () => {
    const prefs = await definePreferences(schema, { store: memoryStore() });

    await mockPreferences<AppPreferences, void>(
      { appearance: { theme: "dark" } },
      async () => {
        expect(prefs.values.appearance.theme).toBe("dark");
        expect(prefs.values.appearance.fontSize).toBe(14);

        await mockPreferences<AppPreferences, void>(
          {
            appearance: { fontSize: 20 },
            editor: { autosave: false, recentFiles: ["a.ts"] },
          },
          async () => {
            expect(prefs.values.appearance.theme).toBe("dark");
            expect(prefs.values.appearance.fontSize).toBe(20);
            expect(prefs.values.editor.autosave).toBe(false);
            expect(prefs.values.editor.recentFiles).toEqual(["a.ts"]);
          },
        );

        expect(prefs.values.appearance.theme).toBe("dark");
        expect(prefs.values.appearance.fontSize).toBe(14);
        expect(prefs.values.editor.autosave).toBe(true);
      },
    );
  });

  test("exceptions still pop the override scope", async () => {
    const prefs = await definePreferences(schema, { store: memoryStore() });

    await expect(
      mockPreferences<AppPreferences, void>(
        { appearance: { theme: "light" } },
        async () => {
          expect(prefs.values.appearance.theme).toBe("light");
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(prefs.values.appearance.theme).toBe("system");
  });

  test("parallel async scopes do not bleed into each other", async () => {
    const prefs = await definePreferences(schema, { store: memoryStore() });

    const [first, second] = await Promise.all([
      mockPreferences<AppPreferences, string>(
        { appearance: { theme: "light" } },
        async () => {
          await Bun.sleep(5);
          return prefs.values.appearance.theme;
        },
      ),
      mockPreferences<AppPreferences, string>(
        { appearance: { theme: "dark" } },
        async () => {
          await Bun.sleep(1);
          return prefs.values.appearance.theme;
        },
      ),
    ]);

    expect(first).toBe("light");
    expect(second).toBe("dark");
    expect(prefs.values.appearance.theme).toBe("system");
  });

  test("mocked subtrees preserve the read-only contract", async () => {
    const prefs = await definePreferences(schema, { store: memoryStore() });

    await mockPreferences<AppPreferences, void>(
      { appearance: { theme: "dark" } },
      async () => {
        expect(Object.keys(prefs.values.appearance)).toEqual([
          "theme",
          "fontSize",
        ]);
        expect(Object.isFrozen(prefs.values.appearance)).toBe(true);
        expect(() => {
          (prefs.values.appearance as { theme: string }).theme = "light";
        }).toThrow(TypeError);
      },
    );
  });

  test("captured mocked subtrees pin non-overridden leaves", async () => {
    const prefs = await definePreferences(schema, { store: memoryStore() });

    await mockPreferences<AppPreferences, void>(
      { appearance: { theme: "dark" } },
      async () => {
        const captured = prefs.values.appearance;

        await prefs.set("appearance.fontSize", 20);

        expect(captured.theme).toBe("dark");
        expect(captured.fontSize).toBe(14);
        expect(prefs.values.appearance.fontSize).toBe(20);
      },
    );
  });
});
