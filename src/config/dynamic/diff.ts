/**
 * Snapshot-diff helper used by the `onChange` payload.
 *
 * Computes the set of **dotted leaf paths** whose value changed
 * between two validated configuration trees. The walker descends
 * into plain nested objects (the only kind `forge/config` produces
 * at boot via `setAtPath`), and treats anything else (URLs, Secrets,
 * arrays, primitives) as a single comparable value.
 *
 * @module
 */

import { isSecret, Secret } from "../secret";

/**
 * Return a sorted list of dotted leaf paths whose value differs
 * between `oldConfig` and `newConfig`.
 *
 * @example
 * ```ts
 * diff(
 *   { app: { port: 3000 }, features: { newCheckout: false } },
 *   { app: { port: 3000 }, features: { newCheckout: true  } },
 * );
 * // → ["features.newCheckout"]
 * ```
 *
 * Notes:
 * - Values are compared with `Object.is` after the descent stops,
 *   so `NaN === NaN` and `+0 / -0` distinctions behave intuitively.
 * - For `URL` instances, equality is the URL's string serialisation,
 *   not reference identity — two parses of the same URL string are
 *   considered equal.
 * - For `Secret<T>` instances, equality is unwrapped value equality.
 *   The unwrap happens locally and the unwrapped value never leaves
 *   this function.
 * - Paths that exist on only one side are reported.
 */
export function diff(
  oldConfig: unknown,
  newConfig: unknown,
): string[] {
  const out: string[] = [];
  walk(oldConfig, newConfig, [], out);
  out.sort();
  return out;
}

function walk(
  a: unknown,
  b: unknown,
  path: readonly string[],
  out: string[],
): void {
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      walk(a[key], b[key], [...path, key], out);
    }
    return;
  }
  if (!equal(a, b)) {
    out.push(path.join("."));
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  // URL equality by serialisation. `instanceof URL` works because both
  // values were produced by the same V8 runtime — the consumers of
  // `diff` are always inside one Bun process.
  if (a instanceof URL && b instanceof URL) {
    return a.toString() === b.toString();
  }

  // Secret equality via the wrapped value. The cost of the unwrap
  // here is justified — `diff` is called once per dynamic update
  // (not per request), and the unwrapped value is discarded
  // immediately.
  if (isSecret(a) && isSecret(b)) {
    return Object.is(
      (a as Secret<unknown>).unwrap(),
      (b as Secret<unknown>).unwrap(),
    );
  }

  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof URL) return false;
  // Anything with a non-Object prototype (Date, Map, Set, URL,
  // Secret, …) is treated as a leaf value, not a record to descend
  // into.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
