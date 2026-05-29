import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { inMemoryInboxStore, sqliteInboxStore } from "../../src/messaging/inbox";
import { IdempotencyError } from "../../src/messaging";
import type { Clock, InboxStore } from "../../src/messaging";

/** A clock whose `now()` the test drives manually. */
function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const factories: Array<{ name: string; make: (clock?: Clock) => InboxStore }> = [
  { name: "inMemoryInboxStore", make: (clock) => inMemoryInboxStore({ clock }) },
  { name: "sqliteInboxStore", make: (clock) => sqliteInboxStore({ clock }) },
];

for (const { name, make } of factories) {
  describe(name, () => {
    test("a fresh key is claimed as new", async () => {
      const inbox = make();
      expect(await inbox.begin("k1")).toBe("new");
    });

    test("an unexpired claim reports in-flight to other workers", async () => {
      const inbox = make();
      expect(await inbox.begin("k1")).toBe("new");
      expect(await inbox.begin("k1")).toBe("in-flight");
    });

    test("a committed key is a duplicate", async () => {
      const inbox = make();
      await inbox.begin("k1");
      await inbox.commit("k1");
      expect(await inbox.begin("k1")).toBe("duplicate");
    });

    test("release frees the claim for reprocessing", async () => {
      const inbox = make();
      await inbox.begin("k1");
      await inbox.release("k1");
      expect(await inbox.begin("k1")).toBe("new");
    });

    test("an expired in-flight claim can be reclaimed", async () => {
      const clock = fakeClock();
      const inbox = make(clock);
      expect(await inbox.begin("k1", { ttlMs: 1_000 })).toBe("new");
      expect(await inbox.begin("k1", { ttlMs: 1_000 })).toBe("in-flight");
      clock.advance(1_001);
      expect(await inbox.begin("k1", { ttlMs: 1_000 })).toBe("new");
    });

    test("a committed key stays a duplicate even after the TTL passes", async () => {
      const clock = fakeClock();
      const inbox = make(clock);
      await inbox.begin("k1", { ttlMs: 1_000 });
      await inbox.commit("k1");
      clock.advance(10_000);
      expect(await inbox.begin("k1", { ttlMs: 1_000 })).toBe("duplicate");
    });
  });
}

describe("sqliteInboxStore", () => {
  test("persists claims across store instances over the same database", async () => {
    const database = new Database(":memory:", { create: true });
    const first = sqliteInboxStore({ database });
    await first.begin("k1");
    await first.commit("k1");

    const second = sqliteInboxStore({ database });
    expect(await second.begin("k1")).toBe("duplicate");
  });

  test("rejects an unsafe table name", () => {
    expect(() => sqliteInboxStore({ table: "inbox; DROP TABLE x" })).toThrow(
      IdempotencyError,
    );
  });
});
