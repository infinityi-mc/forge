/**
 * Conformance scenarios for dynamic config providers.
 *
 * Provider authors can run this suite against their own
 * `DynamicConfigProvider` implementation to verify the basic
 * read/subscribe/lifecycle contract expected by `defineDynamicConfig`.
 *
 * @module
 */

import type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
} from "../providers/types";

export interface ConfigProviderConformanceHarness {
  provider: DynamicConfigProvider;
  emit(snapshot: DynamicConfigSnapshot): void | Promise<void>;
  abort?(): void | Promise<void>;
}

export type ConfigProviderFactory = () =>
  | ConfigProviderConformanceHarness
  | Promise<ConfigProviderConformanceHarness>;

export interface ConfigProviderConformanceScenario {
  readonly name: string;
  run(factory: ConfigProviderFactory): Promise<void>;
}

export const STANDARD_CONFIG_PROVIDER_SCENARIOS: readonly ConfigProviderConformanceScenario[] =
  [
    {
      name: "get is idempotent before the first update",
      async run(factory) {
        const { provider } = await factory();
        const first = await provider.get();
        const second = await provider.get();
        assertSnapshotEqual(first, second, "expected two get() calls to match");
        await provider.shutdown?.();
      },
    },
    {
      name: "subscribe receives emitted snapshots in arrival order",
      async run(factory) {
        const { provider, emit } = await factory();
        const received: DynamicConfigSnapshot[] = [];
        const unsubscribe = provider.subscribe((snapshot) => {
          received.push(snapshot);
        });

        const one = { "features.a": "true" };
        const two = { "features.a": "false" };
        await emit(one);
        await emit(two);
        await provider.flush?.();

        assertSnapshotEqual(received[0], one, "expected first emitted snapshot first");
        assertSnapshotEqual(received[1], two, "expected second emitted snapshot second");
        if (received.length !== 2) {
          throw new Error(`expected exactly 2 snapshots, got ${received.length}`);
        }
        unsubscribe();
        await provider.shutdown?.();
      },
    },
    {
      name: "flush resolves after pending work drains",
      async run(factory) {
        const { provider, emit } = await factory();
        let count = 0;
        provider.subscribe(() => {
          count += 1;
        });
        await emit({ "features.flush": "true" });
        await provider.flush?.();
        if (count !== 1) {
          throw new Error(`expected flush to drain one update, got ${count}`);
        }
        await provider.shutdown?.();
      },
    },
    {
      name: "shutdown stops further subscribe callbacks",
      async run(factory) {
        const { provider, emit } = await factory();
        let count = 0;
        provider.subscribe(() => {
          count += 1;
        });
        await provider.shutdown?.();
        await emit({ "features.afterShutdown": "true" });
        await provider.flush?.();
        if (count !== 0) {
          throw new Error(`expected no callbacks after shutdown, got ${count}`);
        }
      },
    },
    {
      name: "provider isolates consumer onChange errors",
      async run(factory) {
        const { provider, emit } = await factory();
        let healthyCalls = 0;
        provider.subscribe(() => {
          throw new Error("consumer failed");
        });
        provider.subscribe(() => {
          healthyCalls += 1;
        });
        await emit({ "features.errorIsolation": "true" });
        await provider.flush?.();
        if (healthyCalls !== 1) {
          throw new Error(
            `expected healthy subscriber to receive update, got ${healthyCalls}`,
          );
        }
        await provider.shutdown?.();
      },
    },
    {
      name: "unsubscribe stops that handler only",
      async run(factory) {
        const { provider, emit } = await factory();
        let removed = 0;
        let active = 0;
        const unsubscribe = provider.subscribe(() => {
          removed += 1;
        });
        provider.subscribe(() => {
          active += 1;
        });
        unsubscribe();
        await emit({ "features.unsubscribe": "true" });
        await provider.flush?.();
        if (removed !== 0 || active !== 1) {
          throw new Error(
            `expected removed=0 and active=1, got removed=${removed} active=${active}`,
          );
        }
        await provider.shutdown?.();
      },
    },
    {
      name: "abort signal stops long-running provider work",
      async run(factory) {
        const { provider, emit, abort } = await factory();
        if (abort === undefined) {
          await provider.shutdown?.();
          return;
        }

        let count = 0;
        provider.subscribe(() => {
          count += 1;
        });
        await abort();
        await emit({ "features.afterAbort": "true" });
        await provider.flush?.();
        if (count !== 0) {
          throw new Error(`expected no callbacks after abort, got ${count}`);
        }
        await provider.shutdown?.();
      },
    },
  ];

export async function assertProviderConformance(
  factory: ConfigProviderFactory,
  scenarios: readonly ConfigProviderConformanceScenario[] = STANDARD_CONFIG_PROVIDER_SCENARIOS,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.run(factory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `config provider conformance: "${scenario.name}" failed - ${message}`,
        { cause: error },
      );
    }
  }
}

export function controllableProvider(
  initial: DynamicConfigSnapshot = {},
  name = "controllable",
): ConfigProviderConformanceHarness {
  const handlers = new Set<DynamicSnapshotHandler>();
  let current = initial;
  let shutDown = false;

  const provider: DynamicConfigProvider = {
    name,
    get() {
      return current;
    },
    subscribe(handler) {
      if (shutDown) return () => {};
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async flush() {
      await Promise.resolve();
    },
    async shutdown() {
      shutDown = true;
      handlers.clear();
    },
  };

  return {
    provider,
    emit(snapshot) {
      current = snapshot;
      if (shutDown) return;
      for (const handler of handlers) {
        try {
          handler(snapshot);
        } catch {
          // Provider contract: one bad consumer does not block the rest.
        }
      }
    },
  };
}

function assertSnapshotEqual(
  actual: DynamicConfigSnapshot | undefined,
  expected: DynamicConfigSnapshot,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}
