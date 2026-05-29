/**
 * `sqliteInboxStore` — a durable {@link InboxStore} backed by
 * `bun:sqlite`.
 *
 * Dedup state lives in a single table keyed by the idempotency key. The
 * claim transition in {@link InboxStore.begin} runs inside a SQLite
 * transaction so two workers racing the same key can never both observe
 * `"new"` — exactly one wins the claim, the other sees `"in-flight"`.
 *
 * This is the `bun:sqlite`-native persistence double the spec's
 * Principle 1 calls for. Sharing the *same* transaction as the handler's
 * business write (full "effective exactly-once" via `forge/data`) lands
 * with the outbox relay in PR C.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { IdempotencyError } from "../errors";
import type { Clock, InboxState, InboxStore } from "../types";

/** Options for {@link sqliteInboxStore}. */
export interface SqliteInboxStoreOptions {
  /** An existing `bun:sqlite` database. Takes precedence over {@link filename}. */
  readonly database?: Database;
  /** Database file to open. Defaults to an in-memory database. */
  readonly filename?: string;
  /** Table name. Defaults to `"_forge_inbox"`. */
  readonly table?: string;
  /** Clock used to expire `in-flight` claims. Defaults to the system clock. */
  readonly clock?: Clock;
}

interface ClaimRow {
  readonly state: string;
  readonly expires_at: number | null;
}

const STATE_DONE = "done";
const STATE_IN_FLIGHT = "in-flight";

/**
 * Create a durable {@link InboxStore} over `bun:sqlite`.
 *
 * @example
 * ```ts
 * import { sqliteInboxStore } from "forge/messaging/inbox";
 *
 * const inbox = sqliteInboxStore({ filename: "./inbox.db" });
 * ```
 */
export function sqliteInboxStore(
  options: SqliteInboxStoreOptions = {},
): InboxStore {
  const table = options.table ?? "_forge_inbox";
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const db =
    options.database ??
    new Database(options.filename ?? ":memory:", { create: true });

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new IdempotencyError(`Invalid inbox table name: "${table}"`);
  }

  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
       key TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       expires_at INTEGER
     )`,
  );

  const selectStmt = db.query<ClaimRow, [string]>(
    `SELECT state, expires_at FROM ${table} WHERE key = ?`,
  );
  const upsertClaimStmt = db.query(
    `INSERT INTO ${table} (key, state, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at`,
  );
  const commitStmt = db.query(
    `INSERT INTO ${table} (key, state, expires_at) VALUES (?, ?, NULL)
     ON CONFLICT(key) DO UPDATE SET state = excluded.state, expires_at = NULL`,
  );
  const deleteStmt = db.query(`DELETE FROM ${table} WHERE key = ?`);

  // Atomic claim transition: read the existing row and, when the key is
  // free or its claim has expired, write a fresh in-flight claim — all
  // inside one transaction so concurrent claims can't both win.
  const claim = db.transaction((key: string, ttlMs: number | null): InboxState => {
    const existing = selectStmt.get(key);
    if (existing !== null) {
      if (existing.state === STATE_DONE) return "duplicate";
      const expired =
        existing.expires_at !== null && clock.now() > existing.expires_at;
      if (!expired) return "in-flight";
    }
    const expiresAt = ttlMs !== null ? clock.now() + ttlMs : null;
    upsertClaimStmt.run(key, STATE_IN_FLIGHT, expiresAt);
    return "new";
  });

  return {
    async begin(key: string, opts?: { ttlMs?: number }): Promise<InboxState> {
      try {
        return claim(key, opts?.ttlMs ?? null);
      } catch (cause) {
        throw new IdempotencyError("Inbox claim failed", { cause, key });
      }
    },

    async commit(key: string): Promise<void> {
      commitStmt.run(key, STATE_DONE);
    },

    async release(key: string): Promise<void> {
      deleteStmt.run(key);
    },
  };
}
