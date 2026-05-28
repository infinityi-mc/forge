/**
 * `t.url` — parses the env value into a native `URL` object.
 *
 * `t.url.secret()` is the opt-in escape hatch for URLs whose host
 * contains a credential — it wraps the parsed `URL` in {@link Secret}
 * so accidental logging redacts the whole URL rather than just the
 * password segment.
 *
 * @module
 */

import { Secret } from "../../secret";
import { Leaf, type LeafParseResult } from "../types";

export class UrlLeaf extends Leaf<URL> {
  readonly kind = "url";

  protected override _cloneSelf(): UrlLeaf {
    return new UrlLeaf();
  }

  parse(raw: string): LeafParseResult<URL> {
    const trimmed = raw.trim();
    try {
      return { ok: true, value: new URL(trimmed) };
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.message
          ? `Invalid URL: ${cause.message}.`
          : "Invalid URL.";
      return { ok: false, reason };
    }
  }

  /**
   * Wrap the parsed URL in {@link Secret} so the value is redacted
   * across `console.log`, `JSON.stringify`, and `util.inspect`. Useful
   * for connection strings whose host segment contains credentials.
   */
  secret(): UrlSecretLeaf {
    const c = new UrlSecretLeaf();
    this._copyBaseTo(c);
    c.isSecret = true;
    // `_copyBaseTo` carries the `UrlLeaf` default verbatim — but the
    // secret leaf is typed `Secret<URL>`. Wrap the default here so a
    // downstream `.unwrap()` doesn't crash.
    if (c.hasDefault) {
      c.defaultValue = new Secret(c.defaultValue as unknown as URL);
    }
    return c;
  }
}

/**
 * `t.url.secret()` — `URL`-parsing leaf whose value is wrapped in
 * {@link Secret}.
 */
export class UrlSecretLeaf extends Leaf<Secret<URL>> {
  readonly kind = "url.secret";

  constructor() {
    super();
    this.isSecret = true;
  }

  protected override _cloneSelf(): UrlSecretLeaf {
    return new UrlSecretLeaf();
  }

  parse(raw: string): LeafParseResult<Secret<URL>> {
    const trimmed = raw.trim();
    try {
      return { ok: true, value: new Secret(new URL(trimmed)) };
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.message
          ? `Invalid URL: ${cause.message}.`
          : "Invalid URL.";
      return { ok: false, reason };
    }
  }
}
