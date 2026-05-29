import { describe, expect, test } from "bun:test";
import {
  STANDARD_LIFECYCLE_SCENARIOS,
  assertConformance,
} from "../../../src/lifecycle/testing";
import { boot } from "../../../src/lifecycle";

describe("STANDARD_LIFECYCLE_SCENARIOS", () => {
  test("the stock forge.boot orchestrator satisfies every scenario", async () => {
    await assertConformance();
  });

  test("assertConformance accepts an explicit BootFn", async () => {
    await assertConformance(boot, STANDARD_LIFECYCLE_SCENARIOS);
  });

  // Run each scenario individually so a failure names the exact invariant.
  for (const scenario of STANDARD_LIFECYCLE_SCENARIOS) {
    test(scenario.name, async () => {
      await scenario.run(boot);
    });
  }

  test("a failing scenario is reported with its name", async () => {
    await expect(
      assertConformance(boot, [
        {
          name: "always fails",
          async run() {
            throw new Error("nope");
          },
        },
      ]),
    ).rejects.toThrow(/lifecycle conformance: "always fails" failed — nope/);
  });
});
