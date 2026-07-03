/**
 * Mock-aware live preference values proxy.
 *
 * Production reads go straight through to the current deep-frozen snapshot.
 * When `forge/preference/testing` is imported, leaf reads first consult an
 * AsyncLocalStorage override stack and then fall back to the live snapshot.
 *
 * @module
 */

import type { SnapshotRef } from "../config/dynamic/proxy";
import { isLeaf } from "../config/schema/types";
import { hasPreferenceOverride, readPreferenceOverride } from "./overrides";
import type {
  PreferenceSchema,
  PreferenceSchemaNode,
  PreferenceValues,
} from "./types";

export interface MockablePreferenceValuesOptions {
  readonly namespace?: string;
  readonly mutationHint?: string;
}

export function createMockablePreferenceValues<S extends PreferenceSchema>(
  schema: S,
  ref: SnapshotRef<PreferenceValues<S>>,
  options: MockablePreferenceValuesOptions = {},
): PreferenceValues<S> {
  const namespace = options.namespace ?? "forge/preference";
  const mutationHint =
    options.mutationHint ??
    "preference values are read-only; use set/update/reset.";
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      if (typeof key !== "string" || !(key in schema)) {
        return (ref.current as Record<PropertyKey, unknown>)[key];
      }
      return readNode(schema[key]!, ref.current, [key]);
    },
    has(_target, key) {
      return key in (ref.current as object);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(ref.current as object);
    },
    getOwnPropertyDescriptor(_target, key) {
      const desc = Object.getOwnPropertyDescriptor(ref.current as object, key);
      if (desc === undefined) return undefined;
      return { ...desc, configurable: true };
    },
    getPrototypeOf(_target) {
      return Object.getPrototypeOf(ref.current as object);
    },
    set(_target, key) {
      throw new TypeError(
        `${namespace}: cannot assign to '${String(key)}' - ${mutationHint}`,
      );
    },
    deleteProperty(_target, key) {
      throw new TypeError(
        `${namespace}: cannot delete '${String(key)}' - ${mutationHint}`,
      );
    },
    defineProperty(_target, key) {
      throw new TypeError(
        `${namespace}: cannot defineProperty '${String(key)}' - ${mutationHint}`,
      );
    },
  };

  return new Proxy({}, handler) as PreferenceValues<S>;
}

function readNode(
  schema: PreferenceSchemaNode,
  root: unknown,
  path: readonly string[],
): unknown {
  if (isLeaf(schema)) {
    const override = readPreferenceOverride(path);
    if (override.found) return override.value;
    return getAtPath(root, path);
  }

  if (hasPreferenceOverride(path)) {
    return createOverrideNode(schema, root, path);
  }

  return getAtPath(root, path);
}

function createOverrideNode(
  schema: PreferenceSchema,
  root: unknown,
  path: readonly string[],
): object {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    const childPath = [...path, key];
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: false,
      get() {
        return readNode(child, root, childPath);
      },
    });
  }
  return Object.freeze(out);
}

function getAtPath(root: unknown, path: readonly string[]): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
