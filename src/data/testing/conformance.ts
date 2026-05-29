import { sql } from "../sql";
import type { Db, Driver } from "../types";

export interface DataDriverScenario {
  readonly name: string;
  run(context: DataDriverConformanceContext): Promise<void> | void;
}

export interface DataDriverConformanceContext {
  readonly createDriver: () => Driver;
  readonly createDb: () => Db<any>;
}

export const STANDARD_DATA_DRIVER_SCENARIOS: readonly DataDriverScenario[] = [
  {
    name: "executes a raw query",
    async run({ createDb }) {
      const db = createDb();
      await db.raw(sql`select 1`).execute();
      await db.shutdown();
    },
  },
  {
    name: "supports ping",
    async run({ createDb }) {
      const db = createDb();
      await db.ping();
      await db.shutdown();
    },
  },
  {
    name: "supports shutdown",
    async run({ createDriver }) {
      await createDriver().shutdown?.();
    },
  },
];

export async function assertDriverConformance(
  context: DataDriverConformanceContext,
  scenarios: readonly DataDriverScenario[] = STANDARD_DATA_DRIVER_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(context);
    } catch (cause) {
      throw new Error(`Data driver conformance failed: ${scenario.name}`, { cause });
    }
  }
}
