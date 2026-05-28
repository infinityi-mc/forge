/**
 * Built-in dynamic config providers.
 *
 * Re-exports the `staticProvider` and `pollingProvider` factories
 * plus the `DynamicConfigProvider` contract types. Consumers writing
 * a BYO provider import the types from here.
 *
 * @module
 */

export { pollingProvider } from "./polling";
export type { PollingProviderOptions } from "./polling";

export { staticProvider } from "./static";
export type { StaticProviderOptions } from "./static";

export type {
  DynamicConfigProvider,
  DynamicConfigSnapshot,
  DynamicSnapshotHandler,
} from "./types";
