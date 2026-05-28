/**
 * Recording dynamic config provider for tests.
 *
 * @module
 */

import type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
} from "../providers/types";

export interface RecordingProvider extends DynamicConfigProvider {
  readonly snapshots: readonly DynamicConfigSnapshot[];
  push(snapshot: DynamicConfigSnapshot): void;
  subscriberCount(): number;
}

export interface RecordingProviderOptions {
  name?: string;
}

export function recordingProvider(
  initial: DynamicConfigSnapshot = {},
  options: RecordingProviderOptions = {},
): RecordingProvider {
  const handlers = new Set<DynamicSnapshotHandler>();
  const snapshots: DynamicConfigSnapshot[] = [initial];
  let current = initial;
  let shutDown = false;

  return {
    name: options.name ?? "recording",
    snapshots,
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
    push(snapshot) {
      snapshots.push(snapshot);
      current = snapshot;
      if (shutDown) return;
      for (const handler of handlers) {
        try {
          handler(snapshot);
        } catch {
          // Match pollingProvider: one bad subscriber does not stop
          // later subscribers or poison the provider loop.
        }
      }
    },
    subscriberCount() {
      return handlers.size;
    },
    async flush() {
      await Promise.resolve();
    },
    async shutdown() {
      shutDown = true;
      handlers.clear();
    },
  };
}
