/**
 * `t.boolean` — accepts the canonical CLI-friendly forms enumerated in
 * the module spec: `true` / `false` / `1` / `0` / `yes` / `no` (any
 * casing). Rejects everything else with an explicit diagnostic listing
 * the accepted values — silent coercion is the most common config bug.
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

const TRUE_TOKENS = new Set(["true", "1", "yes"]);
const FALSE_TOKENS = new Set(["false", "0", "no"]);

export class BooleanLeaf extends Leaf<boolean> {
  readonly kind = "boolean";

  protected override _cloneSelf(): BooleanLeaf {
    return new BooleanLeaf();
  }

  parse(raw: string): LeafParseResult<boolean> {
    const token = raw.trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) return { ok: true, value: true };
    if (FALSE_TOKENS.has(token)) return { ok: true, value: false };
    return {
      ok: false,
      reason: 'Must be one of: true, false, 1, 0, yes, no.',
    };
  }
}
