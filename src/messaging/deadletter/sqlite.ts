/**
 * `sqliteDeadLetterStore` — a durable {@link DeadLetterStore} backed by
 * `bun:sqlite`.
 *
 * Each dead-lettered message is stored as a row keyed by message id, with
 * the full envelope and a snapshot of the failing error serialized as
 * JSON so it survives a restart and can be inspected or redriven later.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { MessagingError } from "../errors";
import type {
  DeadLetterEntry,
  DeadLetterStore,
  Message,
  MessageBus,
} from "../types";
import { redrivePublish } from "./redrive";

/** Options for {@link sqliteDeadLetterStore}. */
export interface SqliteDeadLetterStoreOptions {
  /** An existing `bun:sqlite` database. Takes precedence over {@link filename}. */
  readonly database?: Database;
  /** Database file to open. Defaults to an in-memory database. */
  readonly filename?: string;
  /** Table name. Defaults to `"_forge_deadletter"`. */
  readonly table?: string;
}

interface EntryRow {
  readonly id: string;
  readonly topic: string;
  readonly message_json: string;
  readonly error_json: string;
  readonly attempts: number;
  readonly failed_at: string;
}

interface SerializedMessage {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly headers: Record<string, string>;
  readonly occurredAt: string;
  readonly attempt: number;
}

function serializeMessage(message: Message): string {
  const serialized: SerializedMessage = {
    id: message.id,
    type: message.type,
    payload: message.payload,
    headers: { ...message.headers },
    occurredAt: message.occurredAt.toISOString(),
    attempt: message.attempt,
  };
  return JSON.stringify(serialized);
}

function deserializeMessage(json: string): Message {
  const raw = JSON.parse(json) as SerializedMessage;
  return {
    id: raw.id,
    type: raw.type,
    payload: raw.payload,
    headers: raw.headers,
    occurredAt: new Date(raw.occurredAt),
    attempt: raw.attempt,
  };
}

function rowToEntry(row: EntryRow): DeadLetterEntry {
  return {
    message: deserializeMessage(row.message_json),
    topic: row.topic,
    error: JSON.parse(row.error_json) as DeadLetterEntry["error"],
    attempts: row.attempts,
    failedAt: new Date(row.failed_at),
  };
}

/**
 * Create a durable {@link DeadLetterStore} over `bun:sqlite`.
 *
 * @example
 * ```ts
 * import { sqliteDeadLetterStore } from "forge/messaging/deadletter";
 *
 * const dlq = sqliteDeadLetterStore({ filename: "./dlq.db" });
 * ```
 */
export function sqliteDeadLetterStore(
  options: SqliteDeadLetterStoreOptions = {},
): DeadLetterStore {
  const table = options.table ?? "_forge_deadletter";
  const db =
    options.database ??
    new Database(options.filename ?? ":memory:", { create: true });

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new MessagingError(`Invalid dead-letter table name: "${table}"`);
  }

  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id TEXT PRIMARY KEY,
       topic TEXT NOT NULL,
       message_json TEXT NOT NULL,
       error_json TEXT NOT NULL,
       attempts INTEGER NOT NULL,
       failed_at TEXT NOT NULL,
       seq INTEGER
     )`,
  );

  const storeStmt = db.query(
    `INSERT INTO ${table} (id, topic, message_json, error_json, attempts, failed_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       topic = excluded.topic,
       message_json = excluded.message_json,
       error_json = excluded.error_json,
       attempts = excluded.attempts,
       failed_at = excluded.failed_at,
       seq = excluded.seq`,
  );
  const listStmt = db.query<EntryRow, [number]>(
    `SELECT id, topic, message_json, error_json, attempts, failed_at
       FROM ${table} ORDER BY seq DESC LIMIT ?`,
  );
  const getStmt = db.query<EntryRow, [string]>(
    `SELECT id, topic, message_json, error_json, attempts, failed_at
       FROM ${table} WHERE id = ?`,
  );
  const deleteStmt = db.query(`DELETE FROM ${table} WHERE id = ?`);
  const seqRow = db
    .query(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ${table}`)
    .get() as { max_seq: number } | null;

  let seq = seqRow?.max_seq ?? 0;

  return {
    async store(entry: DeadLetterEntry): Promise<void> {
      seq += 1;
      storeStmt.run(
        entry.message.id,
        entry.topic,
        serializeMessage(entry.message),
        JSON.stringify(entry.error),
        entry.attempts,
        entry.failedAt.toISOString(),
        seq,
      );
    },

    async list(opts?: { limit?: number }): Promise<readonly DeadLetterEntry[]> {
      const limit = opts?.limit ?? -1; // SQLite treats a negative LIMIT as "no limit".
      return listStmt.all(limit).map(rowToEntry);
    },

    async redrive(id: string, bus: MessageBus): Promise<void> {
      const row = getStmt.get(id);
      if (row === null) {
        throw new MessagingError(`No dead-letter entry for id "${id}"`);
      }
      await redrivePublish(rowToEntry(row), bus);
    },

    async remove(id: string): Promise<void> {
      deleteStmt.run(id);
    },
  };
}
