import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  jsonFileStore,
  sqliteStore,
  type PreferenceSnapshot,
  type PreferenceStore,
} from "../../src/preference";
import {
  assertPreferenceStoreConformance,
  STANDARD_PREFERENCE_STORE_SCENARIOS,
} from "../../src/preference/testing";

describe("preference store conformance", () => {
  test("jsonFileStore satisfies the standard scenarios including watch", async () => {
    await withTempDir(async (dir) => {
      let index = 0;
      await expect(
        assertPreferenceStoreConformance(() => {
          const file = join(dir, `prefs-${index++}.json`);
          return {
            store: jsonFileStore({
              path: file,
              debounceMs: 10,
              watch: true,
              watchDebounceMs: 5,
            }),
            emitExternal(snapshot: PreferenceSnapshot) {
              return writeSnapshot(file, snapshot);
            },
          };
        }),
      ).resolves.toBeUndefined();
    });
  });

  test("sqliteStore satisfies base scenarios while watch remains opt-in", async () => {
    await withTempDir(async (dir) => {
      let index = 0;
      await expect(
        assertPreferenceStoreConformance(() => ({
          store: sqliteStore({ path: join(dir, `prefs-${index++}.sqlite`) }),
        })),
      ).resolves.toBeUndefined();
    });
  });

  test("standard suite names the PR C invariants", () => {
    expect(STANDARD_PREFERENCE_STORE_SCENARIOS.map((scenario) => scenario.name))
      .toEqual([
        "load returns undefined before first save",
        "save and load round-trip snapshots",
        "load returns isolated snapshots",
        "save replaces the full snapshot",
        "concurrent saves settle to the latest complete snapshot",
        "flush drains pending saves",
        "shutdown is idempotent",
        "watch receives external snapshots in order",
        "watch unsubscribe stops callbacks",
        "watch isolates handler errors",
      ]);
  });

  test("failures identify the scenario name", async () => {
    const broken: PreferenceStore = {
      name: "broken",
      load: async () => undefined,
      save: async () => {},
    };
    const scenario = STANDARD_PREFERENCE_STORE_SCENARIOS.find((entry) =>
      entry.name === "save and load round-trip snapshots",
    );

    await expect(
      assertPreferenceStoreConformance(() => ({ store: broken }), [scenario!]),
    ).rejects.toThrow("save and load round-trip snapshots");
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "forge-pref-conformance-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSnapshot(
  file: string,
  snapshot: PreferenceSnapshot,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, file);
}
