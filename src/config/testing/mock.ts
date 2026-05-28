/**
 * Async-scoped static config overrides.
 *
 * @module
 */

import {
  runWithConfigOverride,
  type DeepPartial,
} from "./context";

/**
 * Run `fn` with config overrides visible to every `defineConfig`
 * handle read in the same async call chain. Overrides are nested
 * partial config objects; nested calls compose with last write wins.
 */
export async function mockConfig<TConfig, T>(
  overrides: DeepPartial<TConfig>,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await runWithConfigOverride(
    overrides as Record<string, unknown>,
    fn,
  );
}

export type { DeepPartial };
