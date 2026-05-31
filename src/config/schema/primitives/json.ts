/**
 * `t.json<T>()` — parses a JSON string env var into a typed object.
 *
 * No structural validation is performed beyond "the string parses"
 * unless callers add a `.validate(...)` predicate. The type
 * parameter is purely informational at the type level without a
 * validator.
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

type JsonValidator<T> = (value: unknown) => value is T;

const DEFAULT_VALIDATION_REASON = "JSON value failed structural validation.";

export class JsonLeaf<T> extends Leaf<T> {
  readonly kind = "json";
  private validator?: JsonValidator<T>;
  private validationReason = DEFAULT_VALIDATION_REASON;

  protected override _cloneSelf(): JsonLeaf<T> {
    const c = new JsonLeaf<T>();
    c.validator = this.validator;
    c.validationReason = this.validationReason;
    return c;
  }

  parse(raw: string): LeafParseResult<T> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "Value must be a JSON string." };
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (this.validator !== undefined) {
        let valid = false;
        try {
          valid = this.validator(parsed);
        } catch {
          valid = false;
        }
        if (!valid) {
          return { ok: false, reason: this.validationReason };
        }
      }
      return { ok: true, value: parsed as T };
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.message
          ? `Invalid JSON: ${cause.message}.`
          : "Invalid JSON.";
      return { ok: false, reason };
    }
  }

  /**
   * Add runtime structural validation for the parsed JSON value.
   * Without this predicate, `t.json<T>()` only verifies that the raw
   * string is valid JSON; TypeScript's `T` is erased at runtime.
   */
  validate<U>(validator: JsonValidator<U>, reason?: string): JsonLeaf<U>;
  validate(
    validator: (value: unknown) => boolean,
    reason?: string,
  ): JsonLeaf<T>;
  validate(
    validator: (value: unknown) => boolean,
    reason = DEFAULT_VALIDATION_REASON,
  ): JsonLeaf<T> {
    const c = this._clone();
    c.validator = validator as JsonValidator<T>;
    c.validationReason = reason;
    return c;
  }
}
