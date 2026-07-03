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

  test("falls back corrupt rows without losing valid rows", async () => {
    const db = new Database(":memory:", { create: true });
    const store = sqliteStore({ database: db });

    await store.save({ "appearance.theme": "dark" });
    db.query("INSERT INTO _forge_preferences (key, value) VALUES (?, ?)").run(
      "appearance.fontSize",
      "{",
    );

    expect(await store.load()).toEqual({
      "appearance.fontSize": undefined,
      "appearance.theme": "dark",
    });

    await store.shutdown?.();
    db.close();
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

  test("preserves __proto__ rows as data without polluting loaded snapshots", async () => {
    const db = new Database(":memory:", { create: true });
    const store = sqliteStore({ database: db });

    await store.save(snapshotWithProto({ polluted: true }));
    const loaded = await store.load();

    expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(
      true,
    );
    expect((loaded as Record<string, unknown>)["__proto__"]).toEqual({
      polluted: true,
    });
    expect(
      (Object.prototype as unknown as Record<string, unknown>).polluted,
    ).toBeUndefined();

    await store.shutdown?.();
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

function snapshotWithProto(value: unknown): PreferenceSnapshot {
  const snapshot: Record<string, unknown> = {};
  Object.defineProperty(snapshot, "__proto__", {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return snapshot;
}
