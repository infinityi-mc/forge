/**
 * `t.string` — string-valued leaf with optional `.url` / `.email`
 * format checks that keep the parsed value as a string (in contrast
 * to {@link UrlLeaf} which returns a native `URL` object).
 *
 * @module
 */

import { Leaf, type LeafParseResult } from "../types";

type StringFormat = "plain" | "url" | "email";

// RFC 5322 is famously over-engineered for runtime validation; this
// regex is the same shape every well-behaved framework uses (one `@`,
// at least one dot in the host, no whitespace). Strict enough to catch
// typos, lenient enough to accept the addresses people actually use.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class StringLeaf extends Leaf<string> {
  readonly kind = "string";
  format: StringFormat = "plain";

  protected override _cloneSelf(): StringLeaf {
    const c = new StringLeaf();
    c.format = this.format;
    return c;
  }

  parse(raw: string): LeafParseResult<string> {
    // 12-Factor convention: trim ambient whitespace. People paste env
    // vars with stray newlines surprisingly often.
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "Value must be a non-empty string." };
    }
    if (this.format === "url") {
      try {
        // We don't keep the URL — just verify it parses.
        new URL(trimmed);
        return { ok: true, value: trimmed };
      } catch {
        return {
          ok: false,
          reason: "Invalid URL. Expected a parseable URL string.",
        };
      }
    }
    if (this.format === "email") {
      if (!EMAIL_RE.test(trimmed)) {
        return { ok: false, reason: "Invalid email format." };
      }
      return { ok: true, value: trimmed };
    }
    return { ok: true, value: trimmed };
  }

  /**
   * Validate the string is a parseable URL while keeping the leaf's
   * value type as `string`. Matches the spec's `t.string.url` shape;
   * see {@link UrlLeaf} when a native `URL` object is preferred.
   */
  get url(): StringLeaf {
    const c = this._clone();
    c.format = "url";
    return c;
  }

  /** Validate the string is in a sensible email shape. */
  get email(): StringLeaf {
    const c = this._clone();
    c.format = "email";
    return c;
  }
}
