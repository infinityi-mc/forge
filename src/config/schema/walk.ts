/**
 * Walk helpers for the schema tree.
 *
 * The walker is used in two phases of {@link defineConfig}:
 *
 * 1. **Discovery** — collect every leaf together with its dotted path
 *    and the env-var name we should read from each {@link ConfigSource}.
 * 2. **Assembly** — re-walk the schema after parsing, building the
 *    typed result tree and deep-freezing it before returning.
 *
 * @module
 */

import type { ConfigSchema } from "../types";
import { isLeaf, type Leaf } from "./types";

/**
 * A single leaf in the schema together with metadata needed by the
 * loader: its dotted path (`"db.pool.max"`), the env-var name (either
 * the leaf's explicit override or the computed snake-case form), and
 * the leaf itself.
 */
export interface LeafEntry {
  readonly path: string;
  readonly envVar: string;
  readonly leaf: Leaf<unknown>;
}

/**
 * Walk a schema and emit one {@link LeafEntry} per terminal leaf in
 * insertion order. Insertion order matters for the diagnostic table —
 * it controls the order issues are reported, which we want to match
 * the schema's declared structure.
 */
export function collectLeaves(schema: ConfigSchema): LeafEntry[] {
  const out: LeafEntry[] = [];
  walk(schema, [], out);
  return out;
}

function walk(
  node: ConfigSchema | Leaf<unknown>,
  pathSegments: readonly string[],
  out: LeafEntry[],
): void {
  if (isLeaf(node)) {
    const path = pathSegments.join(".");
    const envVar = node.envName ?? pathToEnvVar(pathSegments);
    out.push({ path, envVar, leaf: node });
    return;
  }
  // Nested object — recurse. `Object.entries` preserves insertion
  // order for string keys per the ECMAScript spec.
  for (const [key, child] of Object.entries(node)) {
    walk(child as ConfigSchema | Leaf<unknown>, [...pathSegments, key], out);
  }
}

/**
 * `app.port` → `APP_PORT`, `db.pool.max` → `DB_POOL_MAX`.
 *
 * The conversion is intentionally naïve (uppercase + underscore
 * separator) — anything more sophisticated would surprise consumers
 * who looked at the docs and expected `APP_PORT`. For non-trivial
 * mappings, callers should use `.env("CUSTOM_NAME")` on the leaf.
 */
export function pathToEnvVar(segments: readonly string[]): string {
  return segments.map((s) => camelToScreamingSnake(s)).join("_");
}

function camelToScreamingSnake(segment: string): string {
  // Insert `_` between lowercase→uppercase transitions before
  // uppercasing so `redisUrl` becomes `REDIS_URL`, not `REDISURL`.
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toUpperCase();
}

/**
 * Set a value at a dotted path on a nested record, creating
 * intermediate objects as needed. The output mirrors the schema
 * structure exactly.
 */
export function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (path === "") return;
  const segments = path.split(".");
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const existing = cursor[key];
    if (existing === undefined || typeof existing !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Recursively `Object.freeze` an object and every nested object value.
 *
 * Arrays are frozen too. `Secret` instances are frozen so they can't
 * have additional properties slapped on. Primitives are passed through
 * unchanged.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
