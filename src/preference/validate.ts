/**
 * Fail-safe validation for `forge/preference` snapshots.
 *
 * Unlike `forge/config`, preference validation never treats user data as fatal:
 * every invalid leaf falls back independently, preserving valid siblings and
 * reporting structured diagnostics for observability.
 *
 * @module
 */

import { isLeaf, type Leaf, type LeafParseResult } from "../config/schema/types";
import { collectLeaves, setAtPath } from "../config/schema/walk";
import { Secret } from "../config/secret";
import type { ConfigSchema } from "../config/types";
import { PreferenceSchemaError } from "./errors";
import type {
  PreferenceDiagnostic,
  PreferenceSchema,
  PreferenceSnapshot,
  PreferenceValues,
} from "./types";

export interface PreferenceValidationResult<S extends PreferenceSchema> {
  readonly tree: PreferenceValues<S>;
  readonly explicit: PreferenceSnapshot;
  readonly diagnostics: readonly PreferenceDiagnostic[];
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
}

export type PreferenceWriteValidationResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly snapshotValue: unknown;
    }
  | { readonly ok: false; readonly diagnostic: PreferenceDiagnostic };

/** Runtime guard for JS callers and TS escape hatches. */
export function assertPreferenceSchema(schema: PreferenceSchema): void {
  walkSchema(schema, []);
}

export function validatePreferenceSnapshot<S extends PreferenceSchema>(
  schema: S,
  snapshot: PreferenceSnapshot,
): PreferenceValidationResult<S> {
  const diagnostics: PreferenceDiagnostic[] = [];
  const loadedKeys: string[] = [];
  const fallbackKeys: string[] = [];
  const tree: Record<string, unknown> = {};
  const explicit: Record<string, unknown> = {};
  const leaves = collectLeaves(schema as unknown as ConfigSchema);

  for (const entry of leaves) {
    if (!hasOwn(snapshot, entry.path)) {
      setAtPath(tree, entry.path, fallbackValue(entry.leaf));
      loadedKeys.push(entry.path);
      continue;
    }

    const raw = snapshot[entry.path];
    const parsed = parsePreferenceValue(entry.leaf, raw);
    if (parsed.ok) {
      setAtPath(tree, entry.path, parsed.value);
      explicit[entry.path] = snapshotValueForLeaf(entry.leaf, parsed.value);
      loadedKeys.push(entry.path);
      continue;
    }

    setAtPath(tree, entry.path, fallbackValue(entry.leaf));
    loadedKeys.push(entry.path);
    fallbackKeys.push(entry.path);
    diagnostics.push({
      status: "invalid",
      path: entry.path,
      reason: parsed.reason,
      ...(entry.leaf.isSecret ? {} : { received: raw }),
    });
  }

  return {
    tree: tree as PreferenceValues<S>,
    explicit,
    diagnostics,
    loadedKeys,
    fallbackKeys,
  };
}

export function validatePreferenceWriteValue(
  path: string,
  leaf: Leaf<unknown>,
  value: unknown,
): PreferenceWriteValidationResult {
  if (value === undefined) {
    return {
      ok: false,
      diagnostic: {
        status: "invalid",
        path,
        reason:
          "Preference values cannot be set to undefined; use reset(path) to clear an explicit value.",
      },
    };
  }

  const parsed = parsePreferenceValue(leaf, value);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: {
        status: "invalid",
        path,
        reason: parsed.reason,
        ...(leaf.isSecret ? {} : { received: value }),
      },
    };
  }

  return {
    ok: true,
    value: parsed.value,
    snapshotValue: snapshotValueForLeaf(leaf, parsed.value),
  };
}

function walkSchema(node: unknown, path: readonly string[]): void {
  if (isLeaf(node)) {
    if (!node.hasDefault && !node.isOptional) {
      const dotted = path.join(".");
      throw new PreferenceSchemaError(
        `Preference leaf '${dotted}' must declare .default(...) or .optional().`,
        { path: dotted },
      );
    }
    return;
  }

  if (!isPlainRecord(node)) {
    const dotted = path.join(".");
    throw new PreferenceSchemaError(
      dotted.length === 0
        ? "Preference schema must be an object."
        : `Preference schema path '${dotted}' must be an object or schema leaf.`,
      dotted.length === 0 ? undefined : { path: dotted },
    );
  }

  for (const [key, child] of Object.entries(node)) {
    walkSchema(child, [...path, key]);
  }
}

function fallbackValue(leaf: Leaf<unknown>): unknown {
  if (leaf.hasDefault) return leaf.defaultValue;
  return undefined;
}

function parsePreferenceValue(
  leaf: Leaf<unknown>,
  raw: unknown,
): LeafParseResult<unknown> {
  switch (leaf.kind) {
    case "string":
    case "enum":
      return typeof raw === "string"
        ? leaf.parse(raw)
        : invalid(`Expected ${leaf.kind} preference value to be a string.`);
    case "secret":
      return parseSecretPreferenceValue(leaf, raw);
    case "number":
    case "port":
      return typeof raw === "number" || typeof raw === "string"
        ? leaf.parse(String(raw))
        : invalid(`Expected ${leaf.kind} preference value to be a number.`);
    case "boolean":
      return typeof raw === "boolean" ||
        typeof raw === "string" ||
        typeof raw === "number"
        ? leaf.parse(String(raw))
        : invalid("Expected boolean preference value to be a boolean.");
    case "json":
      return parseJsonPreferenceValue(leaf, raw);
    case "url.secret":
      return parseUrlSecretPreferenceValue(leaf, raw);
    case "url":
      return typeof raw === "string" || raw instanceof URL
        ? leaf.parse(String(raw))
        : invalid("Expected URL preference value to be a string.");
    default:
      return typeof raw === "string"
        ? leaf.parse(raw)
        : invalid(`Expected ${leaf.kind} preference value to be a string.`);
  }
}

function parseSecretPreferenceValue(
  leaf: Leaf<unknown>,
  raw: unknown,
): LeafParseResult<unknown> {
  if (raw instanceof Secret) {
    const unwrapped = raw.unwrap();
    return typeof unwrapped === "string"
      ? leaf.parse(unwrapped)
      : invalid("Expected secret preference value to wrap a string.");
  }

  return typeof raw === "string"
    ? leaf.parse(raw)
    : invalid("Expected secret preference value to be a string.");
}

function parseUrlSecretPreferenceValue(
  leaf: Leaf<unknown>,
  raw: unknown,
): LeafParseResult<unknown> {
  if (raw instanceof Secret) {
    const unwrapped = raw.unwrap();
    return typeof unwrapped === "string" || unwrapped instanceof URL
      ? leaf.parse(String(unwrapped))
      : invalid("Expected secret URL preference value to wrap a string or URL.");
  }

  return typeof raw === "string" || raw instanceof URL
    ? leaf.parse(String(raw))
    : invalid("Expected secret URL preference value to be a string.");
}

function snapshotValueForLeaf(leaf: Leaf<unknown>, value: unknown): unknown {
  switch (leaf.kind) {
    case "json":
      return structuredClone(value);
    case "url":
      return value instanceof URL ? value.toString() : String(value);
    case "secret":
      return value instanceof Secret ? value.unwrap() : value;
    case "url.secret":
      if (value instanceof Secret) {
        const unwrapped = value.unwrap();
        return unwrapped instanceof URL ? unwrapped.toString() : String(unwrapped);
      }
      return String(value);
    default:
      return value;
  }
}

function parseJsonPreferenceValue(
  leaf: Leaf<unknown>,
  raw: unknown,
): LeafParseResult<unknown> {
  if (typeof raw === "string") {
    const direct = leaf.parse(raw);
    if (direct.ok) return direct;
    return parseJsonEncodedValue(leaf, raw);
  }

  return parseJsonEncodedValue(leaf, raw);
}

function parseJsonEncodedValue(
  leaf: Leaf<unknown>,
  raw: unknown,
): LeafParseResult<unknown> {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(raw);
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.message
        ? `Value must be JSON-serializable: ${cause.message}.`
        : "Value must be JSON-serializable.";
    return invalid(reason);
  }

  if (encoded === undefined) {
    return invalid("Value must be JSON-serializable.");
  }
  return leaf.parse(encoded);
}

function invalid(reason: string): LeafParseResult<unknown> {
  return { ok: false, reason };
}

function hasOwn(object: PreferenceSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
