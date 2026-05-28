import { describe, expect, test } from "bun:test";
import { createDb, sql, type Driver } from "../../src/data";
import { createSqliteDialect } from "../../src/data/dialects/sqlite";
import { createTestTelemetry } from "../../src/telemetry/testing";

describe("data telemetry", () => {
  test("emits query spans and duration metrics when telemetry is injected", async () => {
    const telemetry = createTestTelemetry();
    const driver: Driver = {
      name: "recording",
      execute: <Row = unknown>() => ({
        rows: [{ value: 1 } as Row],
        numAffectedRows: 1n,
      }),
    };
    const db = createDb({
      dialect: createSqliteDialect(),
      driver,
      telemetry: {
        meter: telemetry.meter,
        tracer: telemetry.tracer,
      },
    });

    await db.raw<{ value: number }>(sql`select ${1} as value`).execute();
    await telemetry.flushAll();

    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]!.name).toBe("db.query");
    expect(telemetry.spans[0]!.attributes["db.system"]).toBe("sqlite");
    expect(telemetry.spans[0]!.attributes["db.statement"]).toBe("select ? as value");
    expect(telemetry.spans[0]!.attributes["db.rows_affected"]).toBe(1);

    const metricNames = telemetry.batches.flatMap((batch) =>
      batch.metrics.map((metric) => metric.descriptor.name),
    );
    expect(metricNames).toContain("forge_db_query_duration_seconds");
  });

  test("ping delegates to the driver when available", async () => {
    let pinged = false;
    const db = createDb({
      dialect: createSqliteDialect(),
      driver: {
        name: "pingable",
        execute: () => ({ rows: [], numAffectedRows: 0n }),
        ping: () => {
          pinged = true;
        },
      },
    });

    await db.ping();
    expect(pinged).toBe(true);
  });
});
