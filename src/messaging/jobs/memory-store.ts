/**
 * `inMemoryJobStore` — a non-durable {@link JobStore} for tests and
 * single-process use. Mirrors the claim / complete / retry semantics of
 * {@link sqliteJobStore} so the same {@link createWorker} runs against
 * either.
 *
 * @module
 */

import type {
  ClaimedJobRecord,
  JobStore,
  NewJobRecord,
} from "./types";

interface Row {
  id: string;
  name: string;
  payload: unknown;
  runAt: number;
  attempt: number;
  maxAttempts: number;
  lockedUntil: number;
  intervalMs: number | null;
  dedupKey: string | null;
}

/** Create an in-memory {@link JobStore}. */
export function inMemoryJobStore(): JobStore {
  const rows = new Map<string, Row>();

  const findByKey = (key: string): Row | undefined => {
    for (const row of rows.values()) {
      if (row.dedupKey === key) return row;
    }
    return undefined;
  };

  return {
    async enqueue(record: NewJobRecord): Promise<void> {
      if (record.dedupKey !== null) {
        const existing = findByKey(record.dedupKey);
        if (existing !== undefined) {
          existing.name = record.name;
          existing.payload = record.payload;
          existing.runAt = record.runAt;
          existing.maxAttempts = record.maxAttempts;
          existing.intervalMs = record.intervalMs;
          existing.attempt = 0;
          existing.lockedUntil = 0;
          return;
        }
      }
      rows.set(record.id, {
        id: record.id,
        name: record.name,
        payload: record.payload,
        runAt: record.runAt,
        attempt: 0,
        maxAttempts: record.maxAttempts,
        lockedUntil: 0,
        intervalMs: record.intervalMs,
        dedupKey: record.dedupKey,
      });
    },

    async claim(
      now: number,
      visibilityMs: number,
    ): Promise<ClaimedJobRecord | null> {
      let candidate: Row | undefined;
      for (const row of rows.values()) {
        if (row.runAt > now || row.lockedUntil > now) continue;
        if (candidate === undefined || row.runAt < candidate.runAt) {
          candidate = row;
        }
      }
      if (candidate === undefined) return null;
      candidate.lockedUntil = now + visibilityMs;
      candidate.attempt += 1;
      return {
        id: candidate.id,
        name: candidate.name,
        payload: candidate.payload,
        attempt: candidate.attempt,
        maxAttempts: candidate.maxAttempts,
        intervalMs: candidate.intervalMs,
      };
    },

    async complete(id: string, now: number): Promise<void> {
      const row = rows.get(id);
      if (row === undefined) return;
      if (row.intervalMs !== null) {
        row.runAt = now + row.intervalMs;
        row.attempt = 0;
        row.lockedUntil = 0;
        return;
      }
      rows.delete(id);
    },

    async retry(id: string, runAt: number): Promise<void> {
      const row = rows.get(id);
      if (row === undefined) return;
      row.runAt = runAt;
      row.lockedUntil = 0;
    },

    async size(): Promise<number> {
      return rows.size;
    },
  };
}
