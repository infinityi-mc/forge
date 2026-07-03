/**
 * Conformance scenarios for `forge/preference` stores.
 *
 * Store authors can run this suite against a custom `PreferenceStore` to verify
 * the persistence, lifecycle, and optional watch contract expected by
 * `definePreferences`. Concurrent save scenarios enforce last-call-wins by
 * invocation order: after overlapping `save(A)`, `save(B)`, `flush()`, `load()`
 * must return B even if the underlying I/O for A settles later.
 *
 * @module
 */

import type {
  PreferenceSnapshot,
  PreferenceSnapshotHandler,
  PreferenceStore,
} from "../types";

export interface PreferenceStoreConformanceHarness {
  readonly store: PreferenceStore;
  emitExternal?(snapshot: PreferenceSnapshot): void | Promise<void>;
}

export type PreferenceStoreFactory = () =>
  | PreferenceStoreConformanceHarness
  | Promise<PreferenceStoreConformanceHarness>;

export interface PreferenceStoreConformanceScenario {
  readonly name: string;
  run(factory: PreferenceStoreFactory): Promise<void>;
}

const ROUND_TRIP_SNAPSHOT = {
  "appearance.theme": "dark",
  "editor.settings": { nested: { fontSize: 14 }, files: ["a.ts"] },
} satisfies PreferenceSnapshot;

export const STANDARD_PREFERENCE_STORE_SCENARIOS: readonly PreferenceStoreConformanceScenario[] =
  [
    {
      name: "load returns undefined before first save",
      async run(factory) {
        const { store } = await factory();
        try {
          const loaded = await store.load();
          if (loaded !== undefined) {
            throw new Error(`expected undefined, got ${stableJson(loaded)}`);
          }
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "save and load round-trip snapshots",
      async run(factory) {
        const { store } = await factory();
        try {
          await store.save(ROUND_TRIP_SNAPSHOT);
          await store.flush?.();
          assertSnapshotEqual(
            await store.load(),
            ROUND_TRIP_SNAPSHOT,
            "expected loaded snapshot to match saved snapshot",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "load returns isolated snapshots",
      async run(factory) {
        const { store } = await factory();
        try {
          await store.save(ROUND_TRIP_SNAPSHOT);
          await store.flush?.();

          const loaded = (await store.load()) as Record<string, unknown>;
          const settings = loaded["editor.settings"] as {
            nested: { fontSize: number };
            files: string[];
          };
          settings.nested.fontSize = 99;
          settings.files.push("mutated.ts");

          assertSnapshotEqual(
            await store.load(),
            ROUND_TRIP_SNAPSHOT,
            "expected store data to be isolated from loaded snapshot mutation",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "save replaces the full snapshot",
      async run(factory) {
        const { store } = await factory();
        try {
          await store.save({ "a.one": 1, "b.two": 2 });
          await store.flush?.();
          await store.save({ "a.one": 3 });
          await store.flush?.();
          assertSnapshotEqual(
            await store.load(),
            { "a.one": 3 },
            "expected stale keys to be removed on save",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "concurrent saves settle to the latest complete snapshot",
      async run(factory) {
        const { store } = await factory();
        try {
          await Promise.all([
            store.save({ "first.value": 1 }),
            store.save({ "second.value": 2 }),
          ]);
          await store.flush?.();
          assertSnapshotEqual(
            await store.load(),
            { "second.value": 2 },
            "expected latest save call to replace the full snapshot",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "flush drains pending saves",
      async run(factory) {
        const { store } = await factory();
        try {
          await store.save({ "flush.value": true });
          await store.flush?.();
          assertSnapshotEqual(
            await store.load(),
            { "flush.value": true },
            "expected flush to persist pending snapshot",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "shutdown is idempotent",
      async run(factory) {
        const { store } = await factory();
        try {
          await store.save({ "shutdown.value": true });
        } finally {
          await store.shutdown?.();
          await store.shutdown?.();
        }
      },
    },
    {
      name: "watch receives external snapshots in order",
      async run(factory) {
        const { store, emitExternal } = await factory();
        try {
          if (store.watch === undefined || emitExternal === undefined) return;
          const received: PreferenceSnapshot[] = [];
          store.watch((snapshot) => {
            received.push(snapshot);
          });

          const one = { "watch.value": 1 } satisfies PreferenceSnapshot;
          const two = { "watch.value": 2 } satisfies PreferenceSnapshot;
          await emitExternal(one);
          await waitFor(
            () => received.length === 1,
            "expected first external snapshot",
          );
          await emitExternal(two);
          await waitFor(
            () => received.length === 2,
            "expected second external snapshot",
          );

          assertSnapshotEqual(received[0], one, "expected first snapshot first");
          assertSnapshotEqual(received[1], two, "expected second snapshot second");
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "watch unsubscribe stops callbacks",
      async run(factory) {
        const { store, emitExternal } = await factory();
        try {
          if (store.watch === undefined || emitExternal === undefined) return;
          let removed = 0;
          let active = 0;
          const unsubscribe = store.watch(() => {
            removed += 1;
          });
          store.watch(() => {
            active += 1;
          });
          unsubscribe();

          await emitExternal({ "watch.unsubscribe": true });
          await waitFor(() => active === 1, "expected active watcher callback");
          if (removed !== 0) {
            throw new Error(`expected removed=0, got ${removed}`);
          }
        } finally {
          await store.shutdown?.();
        }
      },
    },
    {
      name: "watch isolates handler errors",
      async run(factory) {
        const { store, emitExternal } = await factory();
        try {
          if (store.watch === undefined || emitExternal === undefined) return;
          let healthyCalls = 0;
          store.watch(() => {
            throw new Error("consumer failed");
          });
          store.watch(() => {
            healthyCalls += 1;
          });

          await emitExternal({ "watch.errorIsolation": true });
          await waitFor(
            () => healthyCalls === 1,
            "expected healthy watcher callback",
          );
        } finally {
          await store.shutdown?.();
        }
      },
    },
  ];

export async function assertPreferenceStoreConformance(
  factory: PreferenceStoreFactory,
  scenarios: readonly PreferenceStoreConformanceScenario[] = STANDARD_PREFERENCE_STORE_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `preference store conformance: "${scenario.name}" failed - ${message}`,
        { cause: error },
      );
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertSnapshotEqual(
  actual: PreferenceSnapshot | undefined,
  expected: PreferenceSnapshot,
  message: string,
): void {
  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
  return sorted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
