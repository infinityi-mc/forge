import { TokenInvalidError } from "../errors";
import type { Principal, TokenVerifier } from "../types";
import { base64UrlEncodeBytes, encodeUtf8 } from "./base64url";

export interface ApiKeyLookupResult {
  readonly fingerprint: string;
  readonly principal: Principal;
}

export interface ApiKeyVerifierOptions {
  readonly lookup:
    (fingerprint: string) =>
      | ApiKeyLookupResult
      | null
      | undefined
      | Promise<ApiKeyLookupResult | null | undefined>;
}

export async function apiKeyFingerprint(rawKey: string): Promise<string> {
  if (!isValidApiKey(rawKey)) {
    throw new TokenInvalidError("API key is missing or malformed");
  }
  const bytes = encodeUtf8(rawKey);
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

export function createApiKeyVerifier(
  options: ApiKeyVerifierOptions,
): TokenVerifier {
  return {
    async verify(token: string): Promise<Principal> {
      if (!isValidApiKey(token)) {
        throw new TokenInvalidError("API key is missing or malformed");
      }

      const fingerprint = await apiKeyFingerprint(token);
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

function isValidApiKey(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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
