/**
 * `sqliteTransport` — a durable, single-node {@link Transport} backed by
 * `bun:sqlite`.
 *
 * Records survive process restarts: `send` inserts each record into a
 * table, and subscriptions claim rows with a short-lived visibility lock
 * before invoking `onMessage`. An `ack` deletes the row; a `nack`
 * (or a delivery left unsettled, or a crash that lets the lock expire)
 * makes the row visible again for redelivery, up to `maxDeliveries`.
 *
 * Delivery is **at-least-once** with competing-consumer semantics: each
 * record is handed to exactly one matching subscription. Pair a consumer
 * with an `InboxStore` for effective exactly-once.
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { NOOP_LOGGER } from "../../observability";
import { TransportError } from "../../errors";
import { topicWildcardPrefix } from "../../topic";
import type {
  Clock,
  Logger,
  Transport,
  TransportDelivery,
  TransportHandle,
  TransportRecord,
  TransportSubscription,
} from "../../types";

/** Options for {@link sqliteTransport}. */
export interface SqliteTransportOptions {
  /** An existing `bun:sqlite` database. Takes precedence over {@link filename}. */
  readonly database?: Database;
  /** Database file to open. Defaults to an in-memory database. */
  readonly filename?: string;
  /** Table name. Defaults to `"_forge_messages"`. */
  readonly table?: string;
  /** Identifier reported as `transport.name`. Default `"sqlite"`. */
  readonly name?: string;
  /**
   * Max times a record is delivered before it is dropped, guarding
   * against a poison message that is always nacked. Default 16.
   */
  readonly maxDeliveries?: number;
  /**
   * How long a claimed record stays invisible to other workers before
   * it is assumed abandoned (e.g. a crashed worker) and redelivered.
   * Default 30000ms.
   */
  readonly visibilityTimeoutMs?: number;
  /** Idle poll interval when the queue is empty, in ms. Default 25. */
  readonly pollIntervalMs?: number;
  /** Opt-in logger for dropped-message warnings. */
  readonly logger?: Logger;
  /** Injectable clock. Defaults to the system clock. */
  readonly clock?: Clock;
}

interface MessageRow {
  readonly seq: number;
  readonly type: string;
  readonly msg_id: string;
  readonly headers: string;
  readonly body: Uint8Array;
  readonly attempt: number;
}

interface Subscription {
  readonly topic: string;
  readonly concurrency: number;
  readonly onMessage: TransportSubscription["onMessage"];
  closed: boolean;
  workers: Promise<void>[];
}

/** Create a durable single-node {@link Transport} over `bun:sqlite`. */
export function sqliteTransport(
  options: SqliteTransportOptions = {},
): Transport & { shutdown(): Promise<void> } {
  const table = options.table ?? "_forge_messages";
  const name = options.name ?? "sqlite";
  const maxDeliveries = Math.max(1, options.maxDeliveries ?? 16);
  const visibilityTimeoutMs = Math.max(1, options.visibilityTimeoutMs ?? 30_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 25);
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const ownsDb = options.database === undefined;
  const db =
    options.database ??
    new Database(options.filename ?? ":memory:", { create: true });

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new TransportError(`Invalid transport table name: "${table}"`, {
      transport: name,
    });
  }

  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       msg_id TEXT NOT NULL,
       headers TEXT NOT NULL,
       body BLOB NOT NULL,
       attempt INTEGER NOT NULL DEFAULT 0,
       visible_at INTEGER NOT NULL DEFAULT 0
     )`,
  );

  const insertStmt = db.query(
    `INSERT INTO ${table} (type, msg_id, headers, body, attempt, visible_at)
     VALUES (?, ?, ?, ?, 0, 0)`,
  );
  const nextStmt = db.query<
    MessageRow,
    [number, string, string, string, string, string]
  >(
     `SELECT seq, type, msg_id, headers, body, attempt FROM ${table}
       WHERE visible_at <= ?
         AND (
           ? = '*'
           OR type = ?
           OR (? <> '' AND substr(type, 1, length(?)) = ?)
         )
       ORDER BY seq ASC LIMIT 1`,
  );
  const lockStmt = db.query(`UPDATE ${table} SET visible_at = ? WHERE seq = ?`);
  const deleteStmt = db.query(`DELETE FROM ${table} WHERE seq = ?`);
  const requeueStmt = db.query(
    `UPDATE ${table} SET attempt = ?, visible_at = ? WHERE seq = ?`,
  );

  // Atomic claim: pick the next visible matching row and lock it within
  // one synchronous transaction so two workers can never claim the same
  // row.
  const claim = db.transaction((topic: string): MessageRow | null => {
    const now = clock.now();
    const prefix = topicWildcardPrefix(topic) ?? "";
    const row = nextStmt.get(now, topic, topic, prefix, prefix, prefix);
    if (row === null) return null;
    lockStmt.run(now + visibilityTimeoutMs, row.seq);
    return row;
  });

  const subscriptions = new Set<Subscription>();
  const waiters = new Set<() => void>();
  let shuttingDown = false;

  const wakeAll = (): void => {
    const current = [...waiters];
    waiters.clear();
    for (const resolve of current) resolve();
  };

  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      waiters.add(resolve);
      setTimeout(() => {
        waiters.delete(resolve);
        resolve();
      }, pollIntervalMs);
    });

  const runWorker = async (sub: Subscription): Promise<void> => {
    while (!sub.closed) {
      const row = claim(sub.topic);
      if (row === null) {
        if (sub.closed) return;
        await idle();
        continue;
      }

      let settled = false;
      const record: TransportRecord = {
        type: row.type,
        id: row.msg_id,
        headers: JSON.parse(row.headers) as Record<string, string>,
        body: row.body,
      };

      const requeue = (): void => {
        const nextAttempt = row.attempt + 1;
        if (nextAttempt >= maxDeliveries) {
          logger.warn("messaging.sqlite.dropped", {
            transport: name,
            type: row.type,
            id: row.msg_id,
            deliveries: nextAttempt,
          });
          deleteStmt.run(row.seq);
          return;
        }
        requeueStmt.run(nextAttempt, clock.now(), row.seq);
        wakeAll();
      };

      const delivery: TransportDelivery = {
        record,
        attempt: row.attempt,
        ack(): void {
          if (settled) return;
          settled = true;
          deleteStmt.run(row.seq);
        },
        nack(): void {
          if (settled) return;
          settled = true;
          requeue();
        },
      };

      try {
        await sub.onMessage(delivery);
        if (!settled) delivery.nack();
      } catch {
        if (!settled) delivery.nack();
      }
    }
  };

  return {
    name,

    async send(records: readonly TransportRecord[]): Promise<void> {
      for (const record of records) {
        insertStmt.run(
          record.type,
          record.id,
          JSON.stringify(record.headers),
          record.body,
        );
      }
      wakeAll();
    },

    async subscribe(
      subscription: TransportSubscription,
    ): Promise<TransportHandle> {
      const sub: Subscription = {
        topic: subscription.topic,
        concurrency: Math.max(1, subscription.concurrency ?? 1),
        onMessage: subscription.onMessage,
        closed: false,
        workers: [],
      };
      subscriptions.add(sub);
      for (let i = 0; i < sub.concurrency; i += 1) {
        sub.workers.push(runWorker(sub));
      }
      return {
        async stop(): Promise<void> {
          sub.closed = true;
          wakeAll();
          await Promise.all(sub.workers);
          subscriptions.delete(sub);
        },
      };
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      const subs = [...subscriptions];
      await Promise.all(
        subs.map(async (sub) => {
          sub.closed = true;
          wakeAll();
          await Promise.all(sub.workers);
        }),
      );
      subscriptions.clear();
      if (ownsDb) db.close();
    },
  };
}
