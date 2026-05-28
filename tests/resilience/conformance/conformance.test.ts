import { describe, expect, test } from "bun:test";
import {
  combine,
  exponentialBackoff,
  fallback,
  hedge,
  retry,
  timeout,
} from "../../../src/resilience";
import {
  POLICY_SPECIFIC_SCENARIOS,
  STANDARD_RESILIENCE_SCENARIOS,
  assertConformance,
  assertPolicyConformance,
} from "../../../src/resilience/testing";

describe("STANDARD_RESILIENCE_SCENARIOS", () => {
  test("identity pipeline (no policies) satisfies every scenario", async () => {
    await assertConformance(() => combine(), STANDARD_RESILIENCE_SCENARIOS);
  });

  test("retry-only pipeline satisfies every scenario", async () => {
    await assertConformance(
      () =>
        combine(
          retry({
            maxAttempts: 1,
            backoff: exponentialBackoff({ initial: 1, jitter: false }),
          }),
        ),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });

  test("timeout-only pipeline satisfies every scenario", async () => {
    await assertConformance(
      () => combine(timeout({ ms: 10_000 })),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });

  test("fallback-only pipeline satisfies every scenario", async () => {
    await assertConformance(
      () => combine(fallback({ fallback: () => "stale" })),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });

  test("hedge-only pipeline satisfies every scenario", async () => {
    await assertConformance(
      () => combine(hedge({ delay: 10_000, maxHedgedAttempts: 1 })),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });

  test("composed pipeline satisfies every scenario", async () => {
    await assertConformance(
      () =>
        combine(
          retry({ maxAttempts: 1 }),
          timeout({ ms: 10_000 }),
        ),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });
});

describe("POLICY_SPECIFIC_SCENARIOS", () => {
  // These scenarios construct their own pipelines from stock policies,
  // so the factory is unused but required by the suite shape.
  test("every policy-specific scenario passes", async () => {
    await assertConformance(() => combine(), POLICY_SPECIFIC_SCENARIOS);
  });
});

describe("assertPolicyConformance helper", () => {
  test("wraps a single policy in combine() and runs the scenarios", async () => {
    await assertPolicyConformance(
      () => retry({ maxAttempts: 1 }),
      STANDARD_RESILIENCE_SCENARIOS,
    );
  });
});

describe("assertConformance error surfacing", () => {
  test("annotates the failing scenario name in the thrown message", async () => {
    const failing = [
      {
        name: "intentionally fails",
        async run() {
          throw new Error("the inner reason");
        },
      },
    ];
    const err = await assertConformance(() => combine(), failing).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("intentionally fails");
    expect((err as Error).message).toContain("the inner reason");
  });
});
