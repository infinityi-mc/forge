/**
 * Internal test-override hook for preference values.
 *
 * The default reader is inert. Importing `forge/preference/testing` installs an
 * AsyncLocalStorage-backed reader without pulling testing code into production.
 *
 * @module
 */

export type PreferenceOverrideLookup =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false };

export interface PreferenceOverrideReader {
  read(path: readonly string[]): PreferenceOverrideLookup;
  has(path: readonly string[]): boolean;
}

let reader: PreferenceOverrideReader | undefined;

export function readPreferenceOverride(
  path: readonly string[],
): PreferenceOverrideLookup {
  return reader?.read(path) ?? { found: false };
}

export function hasPreferenceOverride(path: readonly string[]): boolean {
  return reader?.has(path) ?? false;
}

export function installPreferenceOverrideReader(
  next: PreferenceOverrideReader,
): void {
  reader = next;
}
