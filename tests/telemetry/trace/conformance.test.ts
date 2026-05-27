import { describe, expect, test } from "bun:test";
import {
  STANDARD_SPAN_SCENARIOS,
  recordingSpanExporter,
} from "../../../src/telemetry/trace/testing";

describe("span conformance suite", () => {
  for (const scenario of STANDARD_SPAN_SCENARIOS) {
    test(`recordingSpanExporter: ${scenario.name}`, async () => {
      const exp = recordingSpanExporter();
      await scenario.run(exp);
      expect(() => scenario.assert(exp.spans)).not.toThrow();
    });
  }
});
