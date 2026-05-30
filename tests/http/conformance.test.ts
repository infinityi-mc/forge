import { describe, expect, test } from "bun:test";
import {
  STANDARD_HTTP_SCENARIOS,
  assertConformance,
} from "../../src/http/testing";
import { createHttpClient } from "../../src/http/client";

describe("forge/http client conformance", () => {
  test("the stock createHttpClient satisfies every standard scenario", async () => {
    await expect(assertConformance()).resolves.toBeUndefined();
  });

  test("each scenario passes individually", async () => {
    for (const scenario of STANDARD_HTTP_SCENARIOS) {
      await expect(scenario.run(createHttpClient)).resolves.toBeUndefined();
    }
  });

  test("a broken client fails the suite with a descriptive message", async () => {
    // A client that never throws breaks the throwOnError scenarios.
    const broken = () =>
      createHttpClient({ throwOnError: false, parseProblem: false });
    await expect(assertConformance(broken)).rejects.toThrow(/http conformance/);
  });
});
