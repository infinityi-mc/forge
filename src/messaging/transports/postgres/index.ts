/**
 * `postgresTransport` — a durable, multi-node {@link Transport} backed by
 * PostgreSQL.
 *
 * Records live in a table; subscriptions claim rows with `FOR UPDATE
 * SKIP LOCKED` so many workers across many processes can drain the queue
 * without ever claiming the same row. Claiming sets a short-lived
 * `visible_at` lock; an `ack` deletes the row, a `nack` (or a crash that
 * lets the lock lapse) makes it visible again for redelivery, up to
 * `maxDeliveries`. When the injected client supports `LISTEN`/`NOTIFY`,
 * the transport uses it to wake workers promptly instead of polling.
 *
 * The transport talks to a **structural** {@link PostgresClientLike}
 * (the same shape `forge/data`'s Postgres driver consumes), so it never
 * imports a specific driver and its claim/ack logic is unit-testable
 * against a fake client. Real `LISTEN`/`NOTIFY` needs a live server.
 *
 * @module
 */

import { NOOP_LOGGER } from "../../observability";
import { TransportError } from "../../errors";
import type {
  Clock,
  Logger,
  Transport,
  TransportDelivery,
  TransportHandle,
  TransportRecord,
  TransportSubscription,
} from "../../types";

/** A row returned by {@link PostgresClientLike.query}. */
export interface PostgresQueryResult<Row = unknown> {
  readonly rows?: readonly Row[];
  readonly rowCount?: number | null;
}

/**
 * Structural slice of a PostgreSQL client. Matches `node-postgres`'s
 * `Client`/`Pool` and `forge/data`'s `PostgresClientLike`, so any of
 * them drops in without an import. `on` is optional — when present the
 * transport wires `LISTEN`/`NOTIFY` for low-latency wakeups.
 */
export interface PostgresClientLike {
  query<Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> | PostgresQueryResult<Row>;
  on?(event: "notification", listener: (message: unknown) => void): void;
  removeListener?(
    event: "notification",
    listener: (message: unknown) => void,
  ): void;
}

/** Options for {@link postgresTransport}. */
export interface PostgresTransportOptions {
  /** The PostgreSQL client (a `node-postgres` `Client`/`Pool`, etc.). */
  readonly client: PostgresClientLike;
  /** Table name. Defaults to `"_forge_messages"`. */
  readonly table?: string;
  /** Identifier reported as `transport.name`. Default `"postgres"`. */
  readonly name?: string;
  /**
   * `LISTEN`/`NOTIFY` channel used to wake idle workers. Defaults to
   * `"forge_messages"`. Set to `null` to disable and rely on polling.
   */
  readonly channel?: string | null;
  /** Max deliveries before a record is dropped. Default 16. */
  readonly maxDeliveries?: number;
  /** Visibility lock duration for a claimed record, in ms. Default 30000. */
  readonly visibilityTimeoutMs?: number;
  /** Idle poll interval when the queue is empty, in ms. Default 250. */
  readonly pollIntervalMs?: number;
  /** Run the table migration on first use. Default true. */
  readonly migrate?: boolean;
  /** Opt-in logger for dropped-message warnings. */
  readonly logger?: Logger;
  /** Injectable clock. Defaults to the system clock. */
  readonly clock?: Clock;
}

interface MessageRow {
  readonly seq: number | string;
  readonly type: string;
  readonly msg_id: string;
  readonly headers: string;
  readonly body: string;
  readonly attempt: number;
}

interface Subscription {
  readonly topic: string;
  readonly concurrency: number;
  readonly onMessage: TransportSubscription["onMessage"];
  closed: boolean;
  workers: Promise<void>[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function encodeBody(body: Uint8Array): string {
  return Buffer.from(body).toString("base64");
}

function decodeBody(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Create a durable multi-node {@link Transport} over PostgreSQL. */
export function postgresTransport(
  options: PostgresTransportOptions,
): Transport & { shutdown(): Promise<void> } {
  const client = options.client;
  const table = options.table ?? "_forge_messages";
  const name = options.name ?? "postgres";
  const channel = options.channel === undefined ? "forge_messages" : options.channel;
  const maxDeliveries = Math.max(1, options.maxDeliveries ?? 16);
  const visibilityTimeoutMs = Math.max(1, options.visibilityTimeoutMs ?? 30_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
  const shouldMigrate = options.migrate ?? true;
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const clock: Clock = options.clock ?? { now: () => Date.now() };

  if (!IDENTIFIER.test(table)) {
    throw new TransportError(`Invalid transport table name: "${table}"`, {
      transport: name,
    });
  }
  if (channel !== null && !IDENTIFIER.test(channel)) {
    throw new TransportError(`Invalid LISTEN/NOTIFY channel: "${channel}"`, {
      transport: name,
    });
  }

  const subscriptions = new Set<Subscription>();
  const waiters = new Set<() => void>();
  let prepared: Promise<void> | undefined;
  let notifyListener: ((message: unknown) => void) | undefined;
  let shuttingDown = false;

  const query = async <Row = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<readonly Row[]> => {
    const result = await client.query<Row>(sql, params);
    return result.rows ?? [];
  };

  const wakeAll = (): void => {
    const current = [...waiters];
    waiters.clear();
    for (const resolve of current) resolve();
  };

  const prepare = (): Promise<void> => {
    if (prepared !== undefined) return prepared;
    prepared = (async () => {
      if (shouldMigrate) {
        await query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             seq BIGSERIAL PRIMARY KEY,
             type TEXT NOT NULL,
             msg_id TEXT NOT NULL,
             headers TEXT NOT NULL,
             body TEXT NOT NULL,
             attempt INTEGER NOT NULL DEFAULT 0,
             visible_at BIGINT NOT NULL DEFAULT 0
           )`,
        );
      }
      if (channel !== null && typeof client.on === "function") {
        try {
          await query(`LISTEN ${channel}`);
          notifyListener = () => wakeAll();
          client.on("notification", notifyListener);
        } catch (error) {
          logger.warn("messaging.postgres.listen_failed", {
            transport: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return prepared;
  };

  const claim = async (topic: string): Promise<MessageRow | undefined> => {
    const now = clock.now();
    // Atomic claim: lock the next visible matching row with SKIP LOCKED
    // and bump its visibility in a single round-trip.
    const rows = await query<MessageRow>(
      `WITH next AS (
         SELECT seq FROM ${table}
           WHERE visible_at <= $1 AND ($2 = '*' OR type = $2)
           ORDER BY seq ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       )
       UPDATE ${table} t SET visible_at = $3
         FROM next WHERE t.seq = next.seq
         RETURNING t.seq, t.type, t.msg_id, t.headers, t.body, t.attempt`,
      [now, topic, now + visibilityTimeoutMs],
    );
    return rows[0];
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
      let row: MessageRow | undefined;
      try {
        row = await claim(sub.topic);
      } catch (error) {
        logger.error("messaging.postgres.claim_failed", {
          transport: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (row === undefined) {
        if (sub.closed) return;
        await idle();
        continue;
      }

      let settled = false;
      const record: TransportRecord = {
        type: row.type,
        id: row.msg_id,
        headers: JSON.parse(row.headers) as Record<string, string>,
        body: decodeBody(row.body),
      };

      const requeue = async (): Promise<void> => {
        const nextAttempt = row.attempt + 1;
        if (nextAttempt >= maxDeliveries) {
          logger.warn("messaging.postgres.dropped", {
            transport: name,
            type: row.type,
            id: row.msg_id,
            deliveries: nextAttempt,
          });
          await query(`DELETE FROM ${table} WHERE seq = $1`, [row.seq]);
          return;
        }
        await query(
          `UPDATE ${table} SET attempt = $1, visible_at = $2 WHERE seq = $3`,
          [nextAttempt, clock.now(), row.seq],
        );
        wakeAll();
      };

      const delivery: TransportDelivery = {
        record,
        attempt: row.attempt,
        async ack(): Promise<void> {
          if (settled) return;
          settled = true;
          await query(`DELETE FROM ${table} WHERE seq = $1`, [row.seq]);
        },
        async nack(): Promise<void> {
          if (settled) return;
          settled = true;
          await requeue();
        },
      };

      try {
        await sub.onMessage(delivery);
        if (!settled) await delivery.nack();
      } catch {
        if (!settled) await delivery.nack();
      }
    }
  };

  return {
    name,

    async send(records: readonly TransportRecord[]): Promise<void> {
      await prepare();
      for (const record of records) {
        await query(
          `INSERT INTO ${table} (type, msg_id, headers, body, attempt, visible_at)
           VALUES ($1, $2, $3, $4, 0, 0)`,
          [
            record.type,
            record.id,
            JSON.stringify(record.headers),
            encodeBody(record.body),
          ],
        );
      }
      if (channel !== null) {
        try {
          await query(`NOTIFY ${channel}`);
        } catch {
          // Best-effort wakeup; pollers still drain.
        }
      }
      wakeAll();
    },

    async subscribe(
      subscription: TransportSubscription,
    ): Promise<TransportHandle> {
      await prepare();
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
      if (
        notifyListener !== undefined &&
        typeof client.removeListener === "function"
      ) {
        client.removeListener("notification", notifyListener);
      }
    },
  };
}
