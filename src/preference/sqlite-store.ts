/**
 * Durable SQLite preference store.
 *
 * Stores each explicit dotted preference key as one JSON-encoded row and
 * replaces the full snapshot inside a single SQLite transaction.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { PreferenceStoreError } from "./errors";
import {
  cloneStoreSnapshot,
  CorruptPreferenceSnapshotValue,
  setSnapshotValue,
} from "./store-snapshot";
import type { PreferenceSnapshot, PreferenceStore } from "./types";

export interface SqliteStoreOptions {
  /** Existing `bun:sqlite` database. Takes precedence over `path`. */
  readonly database?: Database;
  /** SQLite database file path. Defaults to an in-memory database. */
  readonly path?: string;
  /** Table name. Defaults to `"_forge_preferences"`. */
  readonly table?: string;
  /** Store name surfaced in diagnostics. Defaults to `"sqlite"`. */
  readonly name?: string;
}

export type SqlitePreferenceStore = PreferenceStore;

interface PreferenceRow {
  readonly key: string;
  readonly value: string;
}

export function sqliteStore(
  options: SqliteStoreOptions = {},
): SqlitePreferenceStore {
  const name = options.name ?? "sqlite";
  const table = options.table ?? "_forge_preferences";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new PreferenceStoreError(`Invalid preference table name: "${table}"`, {
      store: name,
    });
  }

  const ownsDb = options.database === undefined;
  const db = options.database ?? new Database(options.path ?? ":memory:", {
    create: true,
  });

  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  );

  const selectStmt = db.query<PreferenceRow, []>(
    `SELECT key, value FROM ${table} ORDER BY key ASC`,
  );
  const deleteStmt = db.query(`DELETE FROM ${table}`);
  const insertStmt = db.query(
    `INSERT INTO ${table} (key, value) VALUES (?, ?)`,
  );
  const replaceSnapshot = db.transaction(
    (entries: readonly (readonly [string, string])[]): void => {
      deleteStmt.run();
      for (const [key, value] of entries) insertStmt.run(key, value);
    },
  );

  let shutDown = false;

  return {
    name,
    async load(): Promise<PreferenceSnapshot | undefined> {
      assertOpen(name, shutDown, "load");
      const rows = selectStmt.all();
      if (rows.length === 0) return undefined;

      const snapshot: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          setSnapshotValue(snapshot, row.key, JSON.parse(row.value) as unknown);
        } catch (cause) {
          setSnapshotValue(
            snapshot,
            row.key,
            new CorruptPreferenceSnapshotValue(row.key, cause),
          );
        }
      }
      return snapshot;
    },
    async save(snapshot): Promise<void> {
      assertOpen(name, shutDown, "save");
      const entries = Object.entries(cloneStoreSnapshot(snapshot)).map(
        ([key, value]) => [key, encodeValue(key, value)] as const,
      );
      replaceSnapshot(entries);
    },
    async flush(): Promise<void> {},
    async shutdown(): Promise<void> {
      if (shutDown) return;
      shutDown = true;
      if (ownsDb) db.close();
    },
  };
}

function encodeValue(key: string, value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(`Preference value for '${key}' is not JSON-serializable.`);
  }
  return encoded;
}

function assertOpen(name: string, shutDown: boolean, phase: string): void {
  if (!shutDown) return;
  throw new Error(`Preference store '${name}' has been shut down during ${phase}.`);
}
