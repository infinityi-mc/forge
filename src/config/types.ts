/**
 * Cross-module types for `forge/config`.
 *
 * @module
 */

import type { Leaf } from "./schema/types";

/**
 * A configuration schema is a (possibly nested) tree whose leaves are
 * {@link Leaf} instances produced by the `t` builder.
 *
 * `defineConfig(schema)` walks this tree once at boot and produces a
 * deeply-frozen object whose shape is {@link Infer}`<typeof schema>`.
 */
export interface ConfigSchema {
  readonly [key: string]: Leaf<unknown> | ConfigSchema;
}

/**
 * Walk a {@link ConfigSchema} and infer the concrete TypeScript type
 * produced by {@link defineConfig}.
 *
 * - A required leaf typed as `Leaf<T>` becomes `T`.
 * - A leaf marked `.optional()` becomes `T | undefined` (encoded on the
 *   `Leaf<T | undefined>` type parameter at chain time).
 * - A nested object recurses into a `readonly` mapped type, matching
 *   the deep-freeze guarantee.
 */
export type Infer<S> = S extends Leaf<infer T>
  ? T
  : S extends ConfigSchema
    ? { readonly [K in keyof S]: Infer<S[K]> }
    : never;

export type { ConfigDiagnostic } from "./errors";
export type { Leaf } from "./schema/types";
export type { ConfigSource } from "./sources/types";
