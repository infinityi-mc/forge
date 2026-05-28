/**
 * `t.secret` — wraps the raw env value in {@link Secret} without
 * additional parsing. Use this for opaque credentials (JWT signing
 * keys, API tokens) where the value is a free-form string that should
 * never reach a log line.
 *
 * @module
 */

import { Secret } from "../../secret";
import { Leaf, type LeafParseResult } from "../types";

export class SecretLeaf extends Leaf<Secret<string>> {
  readonly kind = "secret";

  constructor() {
    super();
    this.isSecret = true;
  }

  protected override _cloneSelf(): SecretLeaf {
    return new SecretLeaf();
  }

  parse(raw: string): LeafParseResult<Secret<string>> {
    // Secrets are intentionally not trimmed — leading/trailing
    // whitespace is rare in env-injected secrets and trimming risks
    // changing the actual credential (e.g. a base64 value ending in
    // `=` and a literal newline appended by a CI provider).
    if (raw.length === 0) {
      return { ok: false, reason: "Secret value must be non-empty." };
    }
    return { ok: true, value: new Secret(raw) };
  }
}
