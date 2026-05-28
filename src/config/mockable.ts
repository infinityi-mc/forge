/**
 * Frozen accessor facade used by `defineConfig`.
 *
 * Leaves read through the optional override hook before falling back
 * to the validated base snapshot. The hook is inert unless
 * `forge/config/testing` is imported.
 *
 * @module
 */

import { readConfigOverride } from "./overrides";
import { isLeaf, type Leaf } from "./schema/types";
import type { ConfigSchema, Infer } from "./types";

type UnknownRecord = Record<string, unknown>;

export function createMockableConfig<S extends ConfigSchema>(
  schema: S,
  base: Infer<S>,
): Infer<S> {
  return createNode(schema, base as UnknownRecord, []) as Infer<S>;
}

function createNode(
  schema: ConfigSchema,
  baseNode: UnknownRecord,
  path: readonly string[],
): UnknownRecord {
  const out: UnknownRecord = {};

  for (const [key, child] of Object.entries(schema)) {
    const childPath = [...path, key];
    if (isLeaf(child as ConfigSchema | Leaf<unknown>)) {
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: false,
        get() {
          const override = readConfigOverride(childPath);
          if (override.found) return override.value;
          return getAtPath(baseNode, [key]);
        },
      });
      continue;
    }

    const baseChild = getAtPath(baseNode, [key]);
    const childFacade = createNode(
      child as ConfigSchema,
      isRecord(baseChild) ? baseChild : {},
      childPath,
    );
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: false,
      get() {
        return childFacade;
      },
    });
  }

  return Object.freeze(out);
}

function getAtPath(root: UnknownRecord, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
