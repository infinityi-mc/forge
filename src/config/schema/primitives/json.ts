/**
 * `t.json<T>()` — parses a JSON string env var into a typed object.
 *
 * No structural validation is performed beyond "the string parses".
 * The type parameter is purely informational at the type level —
 * callers who need shape validation should keep using `t.json<T>()`
 * for the parse-and-cast and follow up with their own checks.
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

export class JsonLeaf<T> extends Leaf<T> {
  readonly kind = "json";

  protected override _cloneSelf(): JsonLeaf<T> {
    return new JsonLeaf<T>();
  }

  parse(raw: string): LeafParseResult<T> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "Value must be a JSON string." };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as T };
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.message
          ? `Invalid JSON: ${cause.message}.`
          : "Invalid JSON.";
      return { ok: false, reason };
    }
  }
}
