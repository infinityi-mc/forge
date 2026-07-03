import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteStore, type PreferenceSnapshot } from "../../src/preference";

describe("sqliteStore", () => {
  test("loads empty stores as first-run and persists across reopen", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "prefs.sqlite");
      const snapshot = {
        "appearance.theme": "dark",
        "editor.files": ["a.ts"],
      } satisfies PreferenceSnapshot;
      const store = sqliteStore({ path });

      expect(await store.load()).toBeUndefined();
      await store.save(snapshot);
      await store.shutdown?.();

      const reopened = sqliteStore({ path });
      expect(await reopened.load()).toEqual(snapshot);
      await reopened.shutdown?.();
    });
  });

  test("transactional saves replace stale keys", async () => {
    const db = new Database(":memory:", { create: true });
    const store = sqliteStore({ database: db });

    await store.save({ "a.one": 1, "b.two": 2 });
    await store.save({ "a.one": 3 });

    expect(await store.load()).toEqual({ "a.one": 3 });
    await store.shutdown?.();
    expect(db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    db.close();
  });

  test("rejects unsafe table names", () => {
    expect(() => sqliteStore({ table: "prefs; drop table prefs" })).toThrow(
      "Invalid preference table name",
    );
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "forge-pref-sqlite-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
