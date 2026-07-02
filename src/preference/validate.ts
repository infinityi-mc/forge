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
  readonly diagnostics: readonly PreferenceDiagnostic[];
  readonly loadedKeys: readonly string[];
  readonly fallbackKeys: readonly string[];
}

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
    diagnostics,
    loadedKeys,
    fallbackKeys,
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
    case "secret":
      return typeof raw === "string"
        ? leaf.parse(raw)
        : invalid(`Expected ${leaf.kind} preference value to be a string.`);
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
    case "url":
    case "url.secret":
      return typeof raw === "string" || raw instanceof URL
        ? leaf.parse(String(raw))
        : invalid("Expected URL preference value to be a string.");
    default:
      return typeof raw === "string"
        ? leaf.parse(raw)
        : invalid(`Expected ${leaf.kind} preference value to be a string.`);
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
