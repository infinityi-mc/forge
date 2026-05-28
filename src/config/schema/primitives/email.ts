/**
 * `t.email` — alias for `t.string.email`. Validates email shape and
 * keeps the value as a `string`.
 *
 * @module
 */

import { StringLeaf } from "./string";

/** Build an email-validating string leaf. */
export function emailLeaf(): StringLeaf {
  return new StringLeaf().email;
}
