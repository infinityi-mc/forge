/**
 * `createOutboxRelay` — polls `forge/data`'s transactional outbox table
 * and forwards undelivered rows to a {@link MessageBus}.
 *
 * The producer writes a business row and an outbox row in the **same**
 * transaction via `tx.outbox.publish(type, payload)`; this relay then
 * publishes those rows and marks them dispatched. Because publish and
 * mark-dispatched are separate steps, delivery is at-least-once: a crash
 * in between simply re-publishes the row on the next poll. Pair it with
 * an `InboxStore` on the consumer for effective exactly-once.
 *
 * The relay needs three forward-compatible columns on the outbox table
 * (`dispatched_at`, `attempts`, `available_at`); it adds them
 * idempotently on {@link OutboxRelay.start} / first
 * {@link OutboxRelay.drainOnce}. The base table written by `forge/data`
 * (`id`, `type`, `payload`, `metadata`, `occurred_at`) is untouched.
 *
 * @module
 */

import { OutboxRelayError } from "../errors";
import { createOutboxMetrics } from "../observability";
import { NOOP_LOGGER } from "../observability";
import type {
  Clock,
  Logger,
  MessageBus,
  RetryPolicyLike,
} from "../types";
import type {
  DbLike,
  OutboxRelay,
  OutboxRelayOptions,
} from "./types";

interface PendingRow {
  readonly id: number | string;
  readonly type: string;
  readonly payload: string;
  readonly metadata: string | null;
  readonly occurred_at: string;
  readonly attempts: number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

function isDuplicateColumnError(error: unknown): boolean {
  // `forge/data` wraps driver errors in a `QueryError`, so the
  // "duplicate column" text usually lives on the `cause` chain.
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    const message =
      current instanceof Error ? current.message : String(current);
    if (/duplicate column|already exists/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Map outbox metadata (arbitrary JSON) onto string-valued headers. */
function metadataToHeaders(json: string | null): Record<string, string> {
  if (json === null || json === "") return {};
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    headers[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return headers;
}

/**
 * Create an {@link OutboxRelay} over a structural `forge/data` `Db`.
 *
 * @example
 * ```ts
 * import { createOutboxRelay } from "forge/messaging/outbox";
 *
 * const relay = createOutboxRelay({ db, bus });
 * await relay.start();
 * ```
 */
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const db: DbLike = options.db;
  const bus: MessageBus = options.bus;
  const table = options.table ?? "_forge_outbox";
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
  const retryPolicy: RetryPolicyLike | undefined = options.retry;
  const logger: Logger = options.logger ?? NOOP_LOGGER;
  const clock: Clock = options.clock ?? SYSTEM_CLOCK;
  const metrics = createOutboxMetrics(options.telemetry);

  const quoted = db.dialect.quoteIdentifier(table);

  let migrated = false;
  let running = false;
  let stopped = false;
  let loop: Promise<void> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeResolve: (() => void) | undefined;
  let reportedPending = 0;
  let controller = new AbortController();

  const run = async <Row = unknown>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; numAffectedRows: bigint }> => {
    return db.raw<Row>({ text, params }).execute();
  };

  const ensureSchema = async (): Promise<void> => {
    if (migrated) return;
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["dispatched_at", `add column dispatched_at text`],
      ["attempts", `add column attempts integer not null default 0`],
      ["available_at", `add column available_at text`],
    ];
    for (const [column, clause] of additions) {
      try {
        await run(`alter table ${quoted} ${clause}`, []);
      } catch (error) {
        if (isDuplicateColumnError(error)) continue;
        throw new OutboxRelayError(
          `Failed to add outbox column "${column}" to "${table}"`,
          { cause: error, table },
        );
      }
    }
    migrated = true;
  };

  const markDispatched = async (id: PendingRow["id"]): Promise<void> => {
    const at = new Date(clock.now()).toISOString();
    await run(
      `update ${quoted} set dispatched_at = ? where id = ?`,
      [at, id],
    );
  };

  const deferRow = async (row: PendingRow): Promise<void> => {
    const availableAt = new Date(clock.now() + pollIntervalMs).toISOString();
    await run(
      `update ${quoted} set attempts = attempts + 1, available_at = ? where id = ?`,
      [availableAt, row.id],
    );
  };

  const publishRow = async (row: PendingRow): Promise<void> => {
    const payload: unknown = JSON.parse(row.payload);
    const headers = metadataToHeaders(row.metadata);
    const message = {
      id: String(row.id),
      type: row.type,
      payload,
      headers,
      occurredAt: new Date(row.occurred_at),
    };
    if (retryPolicy !== undefined) {
      await retryPolicy.execute(() => bus.publish(message), {
        signal: controller.signal,
        attempt: 1,
      });
    } else {
      await bus.publish(message);
    }
  };

  const updatePendingMetric = async (): Promise<void> => {
    const result = await run<{ pending: number }>(
      `select count(*) as pending from ${quoted} where dispatched_at is null`,
      [],
    );
    const pending = Number(result.rows[0]?.pending ?? 0);
    metrics.pending.add(pending - reportedPending, { table });
    reportedPending = pending;
  };

  const drainOnce = async (): Promise<number> => {
    await ensureSchema();
    const now = new Date(clock.now()).toISOString();
    let rows: readonly PendingRow[];
    try {
      const result = await run<PendingRow>(
        `select id, type, payload, metadata, occurred_at, attempts from ${quoted}
           where dispatched_at is null and (available_at is null or available_at <= ?)
           order by id asc limit ?`,
        [now, batchSize],
      );
      rows = result.rows;
    } catch (error) {
      throw new OutboxRelayError(`Failed to read outbox table "${table}"`, {
        cause: error,
        table,
      });
    }

    let dispatched = 0;
    for (const row of rows) {
      try {
        await publishRow(row);
        await markDispatched(row.id);
        dispatched += 1;
        metrics.dispatched.add(1, { table });
      } catch (error) {
        logger.error("messaging.outbox.publish_failed", {
          table,
          id: String(row.id),
          type: row.type,
          attempts: row.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await deferRow(row);
      }
    }

    await updatePendingMetric();
    return dispatched;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      wakeResolve = resolve;
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        wakeResolve = undefined;
        resolve();
      }, ms);
    });

  const wake = (): void => {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    const resolve = wakeResolve;
    wakeResolve = undefined;
    resolve?.();
  };

  const pollForever = async (): Promise<void> => {
    while (!stopped) {
      let count = 0;
      try {
        count = await drainOnce();
      } catch (error) {
        logger.error("messaging.outbox.drain_failed", {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (stopped) break;
      if (count === 0) await sleep(pollIntervalMs);
    }
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      stopped = false;
      controller = new AbortController();
      await ensureSchema();
      loop = pollForever();
    },

    async stop(): Promise<void> {
      if (!running) return;
      stopped = true;
      controller.abort();
      wake();
      await loop;
      loop = undefined;
      running = false;
    },

    drainOnce,
  };
}
