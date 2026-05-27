import { describe, expect, test } from "bun:test";
import {
  STANDARD_LOG_SCENARIOS,
  assertRecordCount,
  assertRecordLevel,
  assertValidLogRecord,
  recordingTransport,
} from "../../../../src/telemetry/log/testing";

describe("STANDARD_LOG_SCENARIOS", () => {
  for (const scenario of STANDARD_LOG_SCENARIOS) {
    test(scenario.name, async () => {
      const { exporter, records } = recordingTransport();
      await scenario.run(exporter);
      scenario.assert(records);
    });
  }
});

describe("assertion helpers", () => {
  test("assertRecordCount throws on mismatch", () => {
    expect(() => assertRecordCount([], 1)).toThrow();
  });

  test("assertRecordLevel throws on mismatch", () => {
    expect(() =>
      assertRecordLevel(
        {
          level: "info",
          message: "m",
          timestamp: new Date(),
          attributes: {},
        },
        "warn",
      ),
    ).toThrow();
  });

  test("assertValidLogRecord catches malformed records", () => {
    expect(() =>
      assertValidLogRecord({
        level: "bogus" as never,
        message: "m",
        timestamp: new Date(),
        attributes: {},
      }),
    ).toThrow();
  });
});
