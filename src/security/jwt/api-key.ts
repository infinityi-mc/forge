import { TokenInvalidError } from "../errors";
import type { Secret } from "../../config/secret";
import type { Principal, TokenVerifier } from "../types";
import { base64UrlEncodeBytes, encodeUtf8 } from "./base64url";

/** Default minimum raw-key length enforced when no policy overrides it. */
const DEFAULT_MIN_API_KEY_LENGTH = 32;

/**
 * Minimum random bytes for {@link generateApiKey}. 24 bytes base64url-encode to
 * 32 characters, so a generated key (prefix + body) always satisfies the
 * default verifier policy ({@link DEFAULT_MIN_API_KEY_LENGTH}).
 */
const MIN_API_KEY_BYTES = 24;
const PEPPER_KEY_CACHE = new WeakMap<Secret<string>, Promise<CryptoKey>>();

/**
 * Structural requirements for an API key. The defaults reject low-entropy or
 * human-chosen keys; callers who manage their own key format can relax
 * `minLength` (e.g. to `1`) to restore the previous "non-blank" behavior.
 */
export interface ApiKeyPolicy {
  /** Minimum length of the raw key. Defaults to 32. */
  readonly minLength?: number;
  /** If set, the raw key must start with this prefix. */
  readonly requirePrefix?: string;
}

export interface ApiKeyLookupResult {
  readonly fingerprint: string;
  readonly principal: Principal;
}

export interface ApiKeyVerifierOptions {
  readonly lookup: (
    fingerprint: string,
  ) =>
    | ApiKeyLookupResult
    | null
    | undefined
    | Promise<ApiKeyLookupResult | null | undefined>;
  /** Structural policy enforced before lookup. Safe defaults apply. */
  readonly policy?: ApiKeyPolicy;
  /**
   * Server-side pepper. When provided, fingerprints are HMAC-SHA-256 keyed
   * with this secret instead of a bare SHA-256 digest, so leaked fingerprints
   * cannot be attacked offline without the pepper.
   */
  readonly pepper?: Secret<string>;
}

export interface ApiKeyFingerprintOptions {
  readonly pepper?: Secret<string>;
  readonly policy?: ApiKeyPolicy;
}

/**
 * Generate a high-entropy API key from the platform CSPRNG. The default is a
 * `fk_`-prefixed key with 32 random bytes of base64url body. The random body is
 * never fewer than {@link MIN_API_KEY_BYTES} bytes, so the result always meets
 * the default verifier policy regardless of the requested `bytes`.
 */
export function generateApiKey(options?: {
  prefix?: string;
  bytes?: number;
}): string {
  const prefix = options?.prefix ?? "fk_";
  const byteLength = Math.max(options?.bytes ?? 32, MIN_API_KEY_BYTES);
  const random = new Uint8Array(byteLength);
  crypto.getRandomValues(random);
  return `${prefix}${base64UrlEncodeBytes(random)}`;
}

/**
 * Compute the lookup fingerprint for an API key. Safe defaults now enforce the
 * same structural policy as {@link createApiKeyVerifier}: keys must be
 * non-blank and at least 32 characters unless `options.policy.minLength` is
 * explicitly relaxed for legacy key formats.
 */
export async function apiKeyFingerprint(
  rawKey: string,
  options?: ApiKeyFingerprintOptions,
): Promise<string> {
  assertValidApiKey(rawKey, options?.policy);
  return fingerprintValidatedApiKey(rawKey, options?.pepper);
}

export function createApiKeyVerifier(
  options: ApiKeyVerifierOptions,
): TokenVerifier {
  return {
    async verify(token: string): Promise<Principal> {
      assertValidApiKey(token, options.policy);

      const fingerprint = await fingerprintValidatedApiKey(
        token,
        options.pepper,
      );
      const record = await options.lookup(fingerprint);
      if (record === null || record === undefined) {
        throw new TokenInvalidError("API key is invalid");
      }
      if (!constantTimeEqual(fingerprint, record.fingerprint)) {
        throw new TokenInvalidError("API key is invalid");
      }
      return record.principal;
    },
  };
}

async function fingerprintValidatedApiKey(
  rawKey: string,
  pepper: Secret<string> | undefined,
): Promise<string> {
  const input = toArrayBuffer(encodeUtf8(rawKey));
  if (pepper !== undefined) {
    const key = await importedPepperKey(pepper);
    const signature = await crypto.subtle.sign("HMAC", key, input);
    return base64UrlEncodeBytes(new Uint8Array(signature));
  }
  const digest = await crypto.subtle.digest("SHA-256", input);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

function importedPepperKey(pepper: Secret<string>): Promise<CryptoKey> {
  let key = PEPPER_KEY_CACHE.get(pepper);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      "raw",
      toArrayBuffer(encodeUtf8(pepper.unwrap())),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    PEPPER_KEY_CACHE.set(pepper, key);
  }
  return key;
}

function assertValidApiKey(
  value: unknown,
  policy: ApiKeyPolicy | undefined,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TokenInvalidError("API key is missing or malformed");
  }
  const minLength = policy?.minLength ?? DEFAULT_MIN_API_KEY_LENGTH;
  if (value.length < minLength) {
    throw new TokenInvalidError("API key is missing or malformed");
  }
  if (
    policy?.requirePrefix !== undefined &&
    !value.startsWith(policy.requirePrefix)
  ) {
    throw new TokenInvalidError("API key is missing or malformed");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encodeUtf8(left);
  const rightBytes = encodeUtf8(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
