import { describe, expect, test } from "bun:test";
import { memoryStore, type PreferenceSnapshot } from "../../src/preference";

type MutableSnapshot = Record<string, unknown>;

describe("memoryStore", () => {
  test("deep-clones snapshots at every boundary", async () => {
    const initial = {
      "editor.settings": { nested: { fontSize: 14 }, files: ["a.ts"] },
    } satisfies PreferenceSnapshot;
    const store = memoryStore(initial);

    ((initial["editor.settings"] as { nested: { fontSize: number } }).nested
      .fontSize) = 99;
    ((initial["editor.settings"] as { files: string[] }).files).push("b.ts");

    expect(store.snapshot()["editor.settings"]).toEqual({
      nested: { fontSize: 14 },
      files: ["a.ts"],
    });

    const loaded = (await store.load()) as MutableSnapshot;
    ((loaded["editor.settings"] as { nested: { fontSize: number } }).nested
      .fontSize) = 20;
    ((loaded["editor.settings"] as { files: string[] }).files).push("c.ts");

    expect(store.snapshot()["editor.settings"]).toEqual({
      nested: { fontSize: 14 },
      files: ["a.ts"],
    });

    const saved = {
      "editor.settings": { nested: { fontSize: 16 }, files: ["saved.ts"] },
    } satisfies PreferenceSnapshot;
    await store.save(saved);
    ((saved["editor.settings"] as { nested: { fontSize: number } }).nested
      .fontSize) = 21;
    ((saved["editor.settings"] as { files: string[] }).files).push("mutated.ts");

    expect(store.snapshot()["editor.settings"]).toEqual({
      nested: { fontSize: 16 },
      files: ["saved.ts"],
    });

    const snapshot = store.snapshot() as MutableSnapshot;
    ((snapshot["editor.settings"] as { nested: { fontSize: number } }).nested
      .fontSize) = 22;
    ((snapshot["editor.settings"] as { files: string[] }).files).push("view.ts");

    const reloaded = await store.load();
    expect(reloaded?.["editor.settings"]).toEqual({
      nested: { fontSize: 16 },
      files: ["saved.ts"],
    });

    const replacement = {
      "editor.settings": { nested: { fontSize: 18 }, files: ["replace.ts"] },
    } satisfies PreferenceSnapshot;
    store.replace(replacement);
    ((replacement["editor.settings"] as { nested: { fontSize: number } }).nested
      .fontSize) = 23;
    ((replacement["editor.settings"] as { files: string[] }).files).push(
      "changed.ts",
    );

    expect(await store.load()).toEqual({
      "editor.settings": { nested: { fontSize: 18 }, files: ["replace.ts"] },
    });
  });
});
