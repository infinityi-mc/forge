import { describe, expect, test } from "bun:test";
import {
  STANDARD_METER_SCENARIOS,
  recordingMeterExporter,
} from "../../../src/telemetry/meter/testing";

describe("meter conformance suite", () => {
  for (const scenario of STANDARD_METER_SCENARIOS) {
    test(`recordingMeterExporter: ${scenario.name}`, async () => {
      const exp = recordingMeterExporter();
      await scenario.run(exp);
      // Recording exporter starts at index 0 and adds one batch per
      // export() call; scenario.assert receives just the batches the
      // scenario produced.
      expect(() => scenario.assert(exp.batches)).not.toThrow();
    });
  }
});
