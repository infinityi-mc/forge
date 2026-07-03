import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  definePreferences,
  jsonFileStore,
  t,
  type PreferenceDiagnostic,
  type PreferenceSnapshot,
} from "../../src/preference";

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.int.default(14),
  },
};

describe("jsonFileStore", () => {
  test("loads missing files as first-run and persists snapshots", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "prefs.json");
      const snapshot = {
        "appearance.theme": "dark",
        "editor.files": ["a.ts"],
      } satisfies PreferenceSnapshot;
      const store = jsonFileStore({ path: file });

      expect(await store.load()).toBeUndefined();
      await store.save(snapshot);
      await store.flush?.();

      expect(JSON.parse(await Bun.file(file).text())).toEqual(snapshot);
      const reopened = jsonFileStore({ path: file });
      expect(await reopened.load()).toEqual(snapshot);

      await store.shutdown?.();
      await reopened.shutdown?.();
    });
  });

  test("renames corrupt files aside and lets preferences fall back", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "prefs.json");
      await Bun.write(file, "{");
      const diagnostics: PreferenceDiagnostic[] = [];

      const prefs = await definePreferences(schema, {
        store: jsonFileStore({ path: file }),
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic);
        },
      });

      expect(prefs.values.appearance.theme).toBe("system");
      expect(diagnostics[0]?.status).toBe("store_error");
      expect(diagnostics[0]?.reason).toContain("Corrupt preference file");
      expect(await Bun.file(`${file}.corrupt`).exists()).toBe(true);
      expect(await Bun.file(file).exists()).toBe(false);

      await prefs.set("appearance.theme", "dark");
      await prefs.flush();
      expect(JSON.parse(await Bun.file(file).text())).toEqual({
        "appearance.theme": "dark",
      });
      await prefs.shutdown();
    });
  });

  test("debounced saves coalesce and flush persists the latest snapshot", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "prefs.json");
      const store = jsonFileStore({ path: file, debounceMs: 50 });

      await store.save({ "first.value": 1 });
      await store.save({ "second.value": 2 });

      expect(await Bun.file(file).exists()).toBe(false);
      await store.flush?.();
      expect(await store.load()).toEqual({ "second.value": 2 });

      await store.shutdown?.();
    });
  });

  test("successful later saves clear stale background write errors", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "prefs.json");
      const store = jsonFileStore({ path: file, debounceMs: 1 });
      const originalWrite = Bun.write;
      let writeCalls = 0;
      (Bun as unknown as { write: typeof Bun.write }).write = (async (
        ...args: Parameters<typeof Bun.write>
      ) => {
        writeCalls += 1;
        if (writeCalls === 1) throw new Error("transient write failure");
        return originalWrite(...args);
      }) as typeof Bun.write;

      try {
        await store.save({ "first.value": 1 });
        await waitFor(() => writeCalls === 1);

        await store.save({ "second.value": 2 });
        await expect(store.flush?.()).resolves.toBeUndefined();
        expect(await store.load()).toEqual({ "second.value": 2 });
      } finally {
        (Bun as unknown as { write: typeof Bun.write }).write = originalWrite;
        await store.shutdown?.().catch(() => {});
      }
    });
  });

  test("opt-in watch reloads external file edits into definePreferences", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "prefs.json");
      const store = jsonFileStore({ path: file, watch: true, watchDebounceMs: 5 });
      const prefs = await definePreferences(schema, { store });
      const changed: Array<readonly string[]> = [];
      prefs.subscribe((_oldValues, _nextValues, changedKeys) => {
        changed.push(changedKeys);
      });

      await writeSnapshot(file, { "appearance.theme": "dark" });
      await waitFor(() => prefs.values.appearance.theme === "dark");

      expect(changed).toEqual([["appearance.theme"]]);
      expect(prefs.isSet("appearance.theme")).toBe(true);

      await prefs.shutdown();
    });
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "forge-pref-json-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSnapshot(
  file: string,
  snapshot: PreferenceSnapshot,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, file);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
