import { describe, expect, test } from "bun:test";
import { staticProvider } from "../../../src/config/providers/static";
import type { DynamicConfigSnapshot } from "../../../src/config/providers/types";
import {
  assertProviderConformance,
  controllableProvider,
  recordingProvider,
  STANDARD_CONFIG_PROVIDER_SCENARIOS,
} from "../../../src/config/testing";

describe("config provider conformance", () => {
  test("staticProvider satisfies the idempotent and shutdown-safe scenarios", async () => {
    const staticScenarios = STANDARD_CONFIG_PROVIDER_SCENARIOS.filter((scenario) =>
      scenario.name === "get is idempotent before the first update" ||
      scenario.name === "shutdown stops further subscribe callbacks" ||
      scenario.name === "abort signal stops long-running provider work",
    );

    await expect(
      assertProviderConformance(() => ({
        provider: staticProvider({ "features.initial": "true" }),
        emit() {},
      }), staticScenarios),
    ).resolves.toBeUndefined();
  });

  test("recordingProvider satisfies the standard scenarios", async () => {
    await expect(
      assertProviderConformance(() => {
        const provider = recordingProvider({ "features.initial": "true" });
        return {
          provider,
          emit(snapshot: DynamicConfigSnapshot) {
            provider.push(snapshot);
          },
        };
      }),
    ).resolves.toBeUndefined();
  });

  test("a BYO controllable provider satisfies the standard scenarios", async () => {
    await expect(
      assertProviderConformance(() =>
        controllableProvider({ "features.initial": "true" }, "byo"),
      ),
    ).resolves.toBeUndefined();
  });

  test("the standard suite includes the PR C provider invariants", () => {
    expect(
      STANDARD_CONFIG_PROVIDER_SCENARIOS.map((scenario) => scenario.name),
    ).toEqual([
      "get is idempotent before the first update",
      "subscribe receives emitted snapshots in arrival order",
      "flush resolves after pending work drains",
      "shutdown stops further subscribe callbacks",
      "provider isolates consumer onChange errors",
      "unsubscribe stops that handler only",
      "abort signal stops long-running provider work",
    ]);
  });

  test("failures identify the scenario name", async () => {
    await expect(
      assertProviderConformance(
        () => {
          const provider = {
            name: "broken",
            get: () => ({}),
            subscribe: () => () => {},
          };
          return {
            provider,
            emit() {},
          };
        },
        [STANDARD_CONFIG_PROVIDER_SCENARIOS[1]!],
      ),
    ).rejects.toThrow("subscribe receives emitted snapshots in arrival order");
  });

  test("abort-aware harnesses can exercise the abort scenario", async () => {
    const abortScenario = STANDARD_CONFIG_PROVIDER_SCENARIOS.find((scenario) =>
      scenario.name.includes("abort signal"),
    );
    expect(abortScenario).toBeDefined();

    await expect(
      assertProviderConformance(
        () => {
          let aborted = false;
          const harness = controllableProvider(
            { "features.initial": "true" },
            "abort-aware",
          );
          return {
            provider: harness.provider,
            emit(snapshot: DynamicConfigSnapshot) {
              if (!aborted) harness.emit(snapshot);
            },
            abort() {
              aborted = true;
            },
          };
        },
        [abortScenario!],
      ),
    ).resolves.toBeUndefined();
  });
});
