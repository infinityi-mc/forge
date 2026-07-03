/**
 * Async-scoped preference value overrides.
 *
 * @module
 */

import {
  runWithPreferenceOverride,
  type DeepPartial,
} from "./context";

/**
 * Run `fn` with preference value overrides visible through `prefs.values` in
 * the same async call chain. Overrides never write to the backing store.
 *
 * Pass `TValues` explicitly (for example `PreferenceValues<typeof schema>`) to
 * type-check override shapes; otherwise TypeScript infers from the override.
 */
export async function mockPreferences<TValues, T>(
  overrides: DeepPartial<TValues>,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await runWithPreferenceOverride(
    overrides as Record<string, unknown>,
    fn,
  );
}

export type { DeepPartial };
