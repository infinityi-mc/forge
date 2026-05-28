/**
 * `t.port` — integer between 1 and 65535 inclusive.
 *
 * Implemented on top of {@link NumberLeaf} rather than as a free
 * function so the chainable API (`default(3000)`, `optional()`, …) is
 * inherited identically.
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

const PORT_MIN = 1;
const PORT_MAX = 65535;

export class PortLeaf extends Leaf<number> {
  readonly kind = "port";

  protected override _cloneSelf(): PortLeaf {
    return new PortLeaf();
  }

  parse(raw: string): LeafParseResult<number> {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
      return {
        ok: false,
        reason: `"${raw}" is not an integer.`,
      };
    }
    if (parsed < PORT_MIN || parsed > PORT_MAX) {
      return {
        ok: false,
        reason: `"${raw}" is out of bounds (${PORT_MIN}-${PORT_MAX}).`,
      };
    }
    return { ok: true, value: parsed };
  }
}
