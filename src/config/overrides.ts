/**
 * Internal test-override hook for static config accessors.
 *
 * The default reader is a no-op. `forge/config/testing` installs an
 * AsyncLocalStorage-backed reader when that subpath is imported, so
 * the production `forge/config` graph does not import `node:async_hooks`
 * or any testing module.
 *
 * @module
 */

export type ConfigOverrideLookup =
  | { found: true; value: unknown }
  | { found: false };

export type ConfigOverrideReader = (
  path: readonly string[],
) => ConfigOverrideLookup;

let reader: ConfigOverrideReader | undefined;

export function readConfigOverride(path: readonly string[]): ConfigOverrideLookup {
  return reader?.(path) ?? { found: false };
}

export function installConfigOverrideReader(next: ConfigOverrideReader): void {
  reader = next;
}
