/**
 * `sqliteJobStore` — a durable {@link JobStore} backed by `bun:sqlite`.
 *
 * Jobs survive restarts. {@link JobStore.claim} runs inside a SQLite
 * transaction that selects the next runnable row and locks it in one
 * atomic step, so concurrent workers never claim the same job — the
 * single-node analogue of Postgres's `FOR UPDATE SKIP LOCKED`. Recurring
 * jobs (`interval_ms` set) re-schedule themselves on completion instead
 * of being deleted, keeping exactly one row per schedule.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { JobError } from "../errors";
import type {
  ClaimedJobRecord,
  JobStore,
  NewJobRecord,
} from "./types";

/** Options for {@link sqliteJobStore}. */
export interface SqliteJobStoreOptions {
  /** An existing `bun:sqlite` database. Takes precedence over {@link filename}. */
  readonly database?: Database;
  /** Database file to open. Defaults to an in-memory database. */
  readonly filename?: string;
  /** Table name. Defaults to `"_forge_jobs"`. */
  readonly table?: string;
}

interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly payload: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly interval_ms: number | null;
}

/** Create a durable {@link JobStore} over `bun:sqlite`. */
export function sqliteJobStore(options: SqliteJobStoreOptions = {}): JobStore {
  const table = options.table ?? "_forge_jobs";
  const ownsDb = options.database === undefined;
  const db =
    options.database ??
    new Database(options.filename ?? ":memory:", { create: true });

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new JobError(`Invalid job table name: "${table}"`);
  }

  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       payload TEXT NOT NULL,
       run_at INTEGER NOT NULL,
       attempt INTEGER NOT NULL DEFAULT 0,
       max_attempts INTEGER NOT NULL,
       locked_until INTEGER NOT NULL DEFAULT 0,
       interval_ms INTEGER,
       dedup_key TEXT UNIQUE
     )`,
  );

  const insertStmt = db.query(
    `INSERT INTO ${table}
       (id, name, payload, run_at, attempt, max_attempts, locked_until, interval_ms, dedup_key)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)
     ON CONFLICT(dedup_key) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       run_at = excluded.run_at,
       max_attempts = excluded.max_attempts,
       interval_ms = excluded.interval_ms,
       attempt = 0,
       locked_until = 0`,
  );
  const nextStmt = db.query<JobRow, [number, number]>(
    `SELECT id, name, payload, attempt, max_attempts, interval_ms FROM ${table}
       WHERE run_at <= ? AND locked_until <= ?
       ORDER BY run_at ASC, id ASC LIMIT 1`,
  );
  const lockStmt = db.query(
    `UPDATE ${table} SET locked_until = ?, attempt = attempt + 1 WHERE id = ?`,
  );
  const selectStmt = db.query<JobRow, [string]>(
    `SELECT id, name, payload, attempt, max_attempts, interval_ms FROM ${table} WHERE id = ?`,
  );
  const deleteStmt = db.query(`DELETE FROM ${table} WHERE id = ?`);
  const rescheduleStmt = db.query(
    `UPDATE ${table} SET run_at = ?, attempt = 0, locked_until = 0 WHERE id = ?`,
  );
  const retryStmt = db.query(
    `UPDATE ${table} SET run_at = ?, locked_until = 0 WHERE id = ?`,
  );
  const countStmt = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM ${table}`,
  );

  // Atomic claim: select the next runnable row and lock it inside one
  // synchronous transaction — the single-node `FOR UPDATE SKIP LOCKED`.
  const claimTx = db.transaction(
    (now: number, visibilityMs: number): JobRow | null => {
      const row = nextStmt.get(now, now);
      if (row === null) return null;
      lockStmt.run(now + visibilityMs, row.id);
      return row;
    },
  );

  return {
    async enqueue(record: NewJobRecord): Promise<void> {
      try {
        insertStmt.run(
          record.id,
          record.name,
          JSON.stringify(record.payload ?? null),
          record.runAt,
          record.maxAttempts,
          record.intervalMs,
          record.dedupKey,
        );
      } catch (cause) {
        throw new JobError("Failed to enqueue job", {
          cause,
          jobId: record.id,
          jobName: record.name,
        });
      }
    },

    async claim(
      now: number,
      visibilityMs: number,
    ): Promise<ClaimedJobRecord | null> {
      const row = claimTx(now, visibilityMs);
      if (row === null) return null;
      return {
        id: row.id,
        name: row.name,
        payload: JSON.parse(row.payload) as unknown,
        attempt: row.attempt + 1,
        maxAttempts: row.max_attempts,
        intervalMs: row.interval_ms,
      };
    },

    async complete(id: string, now: number): Promise<void> {
      const row = selectStmt.get(id);
      if (row === null) return;
      if (row.interval_ms !== null) {
        rescheduleStmt.run(now + row.interval_ms, id);
        return;
      }
      deleteStmt.run(id);
    },

    async retry(id: string, runAt: number): Promise<void> {
      retryStmt.run(runAt, id);
    },

    async size(): Promise<number> {
      return Number(countStmt.get()?.n ?? 0);
    },

    async close(): Promise<void> {
      if (ownsDb) db.close();
    },
  };
}
