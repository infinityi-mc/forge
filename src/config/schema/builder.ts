/**
 * The `t` builder — public entry point for declaring schema leaves.
 *
 * Each property is a getter so callers receive a fresh leaf instance
 * on every access. This is what lets `default()` / `optional()` /
 * `env()` chain return new objects without mutating any singleton
 * builder state.
 *
 * @module
 */

import { BooleanLeaf } from "./primitives/boolean";
import { emailLeaf } from "./primitives/email";
import { EnumLeaf } from "./primitives/enum";
import { JsonLeaf } from "./primitives/json";
import { NumberLeaf } from "./primitives/number";
import { PortLeaf } from "./primitives/port";
import { SecretLeaf } from "./primitives/secret";
import { StringLeaf } from "./primitives/string";
import { UrlLeaf } from "./primitives/url";

/**
 * Public schema-builder surface. The shape intentionally mirrors the
 * spec table 1:1 — keep additions to this object in lockstep with
 * documented primitives.
 */
export const t = {
  /** String, with whitespace trimming. */
  get string(): StringLeaf {
    return new StringLeaf();
  },
  /** Floating-point number. `t.number.int` for integer-only. */
  get number(): NumberLeaf {
    return new NumberLeaf();
  },
  /** `true` / `false` / `1` / `0` / `yes` / `no` (any casing). */
  get boolean(): BooleanLeaf {
    return new BooleanLeaf();
  },
  /** Integer between 1 and 65535 inclusive. */
  get port(): PortLeaf {
    return new PortLeaf();
  },
  /** Parses into a native `URL` object. */
  get url(): UrlLeaf {
    return new UrlLeaf();
  },
  /** Validates email shape; value type stays `string`. */
  get email(): StringLeaf {
    return emailLeaf();
  },
  /** Restrict to one of a fixed set of string variants. */
  enum<V extends string>(variants: readonly V[]): EnumLeaf<V> {
    return new EnumLeaf<V>(variants);
  },
  /** Wrap the raw value in `Secret` for redacted logging. */
  get secret(): SecretLeaf {
    return new SecretLeaf();
  },
  /** Parse a JSON string env var into a typed object. */
  json<T>(): JsonLeaf<T> {
    return new JsonLeaf<T>();
  },
} as const;
