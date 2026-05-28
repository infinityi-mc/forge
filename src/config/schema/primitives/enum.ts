/**
 * `t.enum([...])` — restrict the value to one of a fixed set of
 * string variants.
 *
 * Variant inference is preserved at the type level: passing
 * `["development", "staging", "production"] as const` (or a literal
 * inline array, which TS narrows) produces a leaf whose `Infer` is
 * the literal union — not the wider `string`.
 *
 * @module
 */

import { ConfigSchemaError } from "../../errors";
import { Leaf, type LeafParseResult } from "../types";

export class EnumLeaf<V extends string> extends Leaf<V> {
  readonly kind = "enum";
  readonly variants: readonly V[];

  constructor(variants: readonly V[]) {
    super();
    if (variants.length === 0) {
      throw new ConfigSchemaError(
        "t.enum() requires at least one variant.",
      );
    }
    this.variants = variants;
  }

  protected override _cloneSelf(): EnumLeaf<V> {
    return new EnumLeaf<V>(this.variants);
  }

  parse(raw: string): LeafParseResult<V> {
    const trimmed = raw.trim();
    for (const variant of this.variants) {
      if (variant === trimmed) return { ok: true, value: variant };
    }
    return {
      ok: false,
      reason: `Must be one of: ${this.variants.join(", ")}.`,
    };
  }
}
