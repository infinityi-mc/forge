/**
 * Public surface for dynamic configuration.
 *
 * @module
 */

export { defineDynamicConfig } from "./define";
export type {
  DefineDynamicConfigOptions,
  DynamicConfigHandle,
} from "./define";

export { diff } from "./diff";

export type { SnapshotRef } from "./proxy";
