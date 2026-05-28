/**
 * `t.number` — floating-point number; `t.number.int` — integer.
 *
 * Parses both decimal and integer string representations. Rejects
 * `NaN`, `±Infinity`, and strings with trailing garbage (`"3px"`).
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

export class NumberLeaf extends Leaf<number> {
  readonly kind = "number";
  isInt = false;

  protected override _cloneSelf(): NumberLeaf {
    const c = new NumberLeaf();
    c.isInt = this.isInt;
    return c;
  }

  parse(raw: string): LeafParseResult<number> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "Value must be a number." };
    }
    // `Number(...)` accepts the syntactic shapes we want and rejects
    // trailing garbage (`Number("3px") === NaN`). `parseFloat` would
    // silently accept it.
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        reason: `"${raw}" is not a finite number.`,
      };
    }
    if (this.isInt && !Number.isInteger(parsed)) {
      return {
        ok: false,
        reason: `"${raw}" is not an integer.`,
      };
    }
    return { ok: true, value: parsed };
  }

  /** Restrict the value to an integer (`Number.isInteger` check). */
  get int(): NumberLeaf {
    const c = this._clone();
    c.isInt = true;
    return c;
  }
}
