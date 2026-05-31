/**
 * Shared validation core used by both `defineConfig` (boot-time
 * static load) and `defineDynamicConfig` (runtime snapshot
 * validation). The two callers differ only in **where** a raw string
 * comes from — the rest of the loop (defaults / optionals / parse /
 * aggregate-diagnostics) is identical, so it lives here.
 *
 * @module
 */

import type { ConfigDiagnostic } from "./errors";
import type { LeafEntry } from "./schema/walk";
import { collectLeaves, setAtPath } from "./schema/walk";
import type { Leaf } from "./schema/types";
import type { ConfigSchema, Infer } from "./types";

/**
 * Source-of-raw-values callback. Returning `undefined` triggers the
 * default / optional / missing-issue branches inside the validator;
 * an empty string is treated as a present-but-empty value and is
 * passed to the leaf parser unchanged (matching `ConfigSource`).
 */
export type SnapshotReader = (entry: LeafEntry) => string | undefined;

/**
 * Outcome of a single validation pass over a schema.
 *
 * - `issues` is empty on success; the caller can treat
 *   `issues.length === 0` as "the tree is ready".
 * - `tree` is **not** deep-frozen here — callers freeze at the layer
 *   that knows whether mutation should be locked (static config
 *   freezes once at boot; dynamic config freezes each snapshot before
 *   exposing it via the proxy).
 * - `loadedKeys` lists **every dotted path the validator placed into
 *   the tree**, including:
 *   - leaves whose raw value was parsed successfully,
 *   - leaves that fell back to a `.default(...)` value, and
 *   - leaves marked `.optional()` that were left as `undefined` so
 *     consumers can use `?.` consistently. (These are still tree
 *     positions, hence still "loaded" — they just hold `undefined`.)
 *   The list is **not** filtered to keys whose final value is
 *   defined; if you need that, intersect with the tree at the caller.
 *   The boot-summary log shape is paths-only, never values.
 * - `redactedKeys` lists the subset of `loadedKeys` that carried a
 *   `Secret`-typed value (parsed-from-source or applied-from-default).
 *   `.optional()` leaves left as `undefined` are *not* listed here
 *   because no secret value exists.
 */
export interface ValidationResult<S extends ConfigSchema> {
  readonly tree: Infer<S>;
  readonly issues: ConfigDiagnostic[];
  readonly loadedKeys: string[];
  readonly redactedKeys: string[];
}

export interface ValidateSnapshotOptions {
  /**
   * Omit raw invalid values from diagnostics, even for non-secret
   * leaves. Secrets are always redacted regardless of this option.
   */
  readonly redactReceived?: boolean;
}

/**
 * Walk every leaf of `schema`, read a raw string for each one via
 * `read`, parse, and assemble the typed tree. Diagnostics are
 * aggregated — the loop never short-circuits on the first error, so
 * the boot operator sees the entire surface of misconfiguration at
 * once.
 *
 * Decision tree per leaf:
 *
 * 1. `read(entry)` returns a string → parse; success builds the
 *    tree, failure pushes a `status: "invalid"` diagnostic.
 * 2. `read(entry)` returns `undefined` and the leaf has a default →
 *    the default is placed in the tree.
 * 3. `read(entry)` returns `undefined` and the leaf is optional →
 *    `undefined` is placed in the tree (so consumers can use `?.`
 *    consistently).
 * 4. `read(entry)` returns `undefined` and the leaf is neither
 *    defaulted nor optional → push a `status: "missing"` diagnostic.
 */
export function validateSnapshot<S extends ConfigSchema>(
  schema: S,
  read: SnapshotReader,
  options: ValidateSnapshotOptions = {},
): ValidationResult<S> {
  const leaves = collectLeaves(schema);
  const issues: ConfigDiagnostic[] = [];
  const tree: Record<string, unknown> = {};
  const loadedKeys: string[] = [];
  const redactedKeys: string[] = [];

  for (const entry of leaves) {
    const raw = read(entry);

    if (raw === undefined) {
      if (entry.leaf.hasDefault) {
        setAtPath(tree, entry.path, entry.leaf.defaultValue);
        loadedKeys.push(entry.path);
        if (entry.leaf.isSecret) redactedKeys.push(entry.path);
        continue;
      }
      if (entry.leaf.isOptional) {
        // Optional leaves are present-but-undefined so consumers can
        // use `?.` consistently across the tree. They count as
        // `loadedKeys` (the validator decided the leaf's tree
        // position) but never as `redactedKeys` — there is no secret
        // value to mask.
        setAtPath(tree, entry.path, undefined);
        loadedKeys.push(entry.path);
        continue;
      }
      issues.push({
        path: entry.path,
        envVar: entry.envVar,
        status: "missing",
        reason: missingReason(entry.leaf),
      });
      continue;
    }

    const parsed = entry.leaf.parse(raw);
    if (parsed.ok) {
      setAtPath(tree, entry.path, parsed.value);
      loadedKeys.push(entry.path);
      if (entry.leaf.isSecret) redactedKeys.push(entry.path);
    } else {
      const includeReceived =
        !entry.leaf.isSecret && options.redactReceived !== true;
      issues.push({
        path: entry.path,
        envVar: entry.envVar,
        status: "invalid",
        reason: parsed.reason,
        // Never echo a secret's raw value into diagnostics. Callers
        // can also suppress raw values globally for production/logging
        // surfaces where even non-secret values may be sensitive.
        ...(includeReceived ? { received: raw } : {}),
      });
    }
  }

  return {
    tree: tree as Infer<S>,
    issues,
    loadedKeys,
    redactedKeys,
  };
}

function missingReason(leaf: Leaf<unknown>): string {
  // Enum leaves get a tailored "Must be one of …" message so the
  // diagnostic table reads like the spec example.
  const variants = (leaf as { variants?: readonly string[] }).variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return `Must be one of: ${variants.join(", ")}.`;
  }
  return `Required ${leaf.kind} value is missing.`;
}
