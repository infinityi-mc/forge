import { Secret } from "../../config/secret";
import {
  AlgorithmNotAllowedError,
  KeyResolutionError,
  TokenInvalidError,
} from "../errors";
import type { JsonWebKey } from "../jwks/types";
import type { JwsAlgorithm } from "./types";

const HMAC_ALGORITHMS = new Set<JwsAlgorithm>(["HS256", "HS384", "HS512"]);
const RSA_ALGORITHMS = new Set<JwsAlgorithm>(["RS256", "RS384", "RS512"]);
const EC_ALGORITHMS = new Set<JwsAlgorithm>(["ES256", "ES384", "ES512"]);

export function isJwsAlgorithm(value: string): value is JwsAlgorithm {
  return (
    value === "RS256" ||
    value === "RS384" ||
    value === "RS512" ||
    value === "ES256" ||
    value === "ES384" ||
    value === "ES512" ||
    value === "EdDSA" ||
    value === "HS256" ||
    value === "HS384" ||
    value === "HS512"
  );
}

export function isHmacAlgorithm(alg: JwsAlgorithm): boolean {
  return HMAC_ALGORITHMS.has(alg);
}

export function isAsymmetricAlgorithm(alg: JwsAlgorithm): boolean {
  return !isHmacAlgorithm(alg);
}

export function hashForAlgorithm(alg: JwsAlgorithm): "SHA-256" | "SHA-384" | "SHA-512" {
  if (alg.endsWith("384")) return "SHA-384";
  if (alg.endsWith("512")) return "SHA-512";
  return "SHA-256";
}

export async function importJwkForVerify(
  jwk: JsonWebKey,
  alg: JwsAlgorithm,
): Promise<CryptoKey> {
  if (isHmacAlgorithm(alg)) {
    throw new AlgorithmNotAllowedError(
      "HMAC algorithms require an hmacSecret key source",
    );
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new KeyResolutionError(`JWK alg ${jwk.alg} does not match ${alg}`);
  }
  if (RSA_ALGORITHMS.has(alg)) {
    if (jwk.kty !== "RSA") {
      throw new KeyResolutionError(`expected RSA JWK for ${alg}`);
    }
    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: hashForAlgorithm(alg) },
      false,
      ["verify"],
    );
  }
  if (EC_ALGORITHMS.has(alg)) {
    const namedCurve = curveForAlgorithm(alg);
    if (jwk.kty !== "EC" || jwk.crv !== namedCurve) {
      throw new KeyResolutionError(`expected ${namedCurve} EC JWK for ${alg}`);
    }
    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "ECDSA", namedCurve },
      false,
      ["verify"],
    );
  }
  if (alg === "EdDSA") {
    if (jwk.kty !== "OKP") {
      throw new KeyResolutionError("expected OKP JWK for EdDSA");
    }
    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "Ed25519" } as any,
      false,
      ["verify"],
    );
  }
  throw new AlgorithmNotAllowedError(`unsupported algorithm ${alg}`);
}

export async function importHmacSecret(
  secret: Secret<string>,
  alg: JwsAlgorithm,
  usage: KeyUse,
): Promise<CryptoKey> {
  if (!isHmacAlgorithm(alg)) {
    throw new AlgorithmNotAllowedError(
      "asymmetric algorithms require a JWKS key source",
    );
  }
  const raw = new TextEncoder().encode(secret.unwrap());
  return crypto.subtle.importKey(
    "raw",
    toBufferSource(raw),
    { name: "HMAC", hash: hashForAlgorithm(alg) },
    false,
    [usage],
  );
}

export async function verifyJwsSignature(
  alg: JwsAlgorithm,
  key: CryptoKey,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const data = toBufferSource(signingInput);
  const sig = toBufferSource(signature);
  try {
    if (RSA_ALGORITHMS.has(alg)) {
      return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        sig,
        data,
      );
    }
    if (EC_ALGORITHMS.has(alg)) {
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: hashForAlgorithm(alg) },
        key,
        sig,
        data,
      );
    }
    if (isHmacAlgorithm(alg)) {
      return await crypto.subtle.verify("HMAC", key, sig, data);
    }
    if (alg === "EdDSA") {
      return await crypto.subtle.verify(
        { name: "Ed25519" } as any,
        key,
        sig,
        data,
      );
    }
  } catch (error) {
    throw new TokenInvalidError("signature verification failed", { cause: error });
  }
  throw new AlgorithmNotAllowedError(`unsupported algorithm ${alg}`);
}

export async function signForTest(
  alg: JwsAlgorithm,
  key: CryptoKey,
  signingInput: Uint8Array,
): Promise<Uint8Array> {
  const data = toBufferSource(signingInput);
  if (RSA_ALGORITHMS.has(alg)) {
    return new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data),
    );
  }
  if (EC_ALGORITHMS.has(alg)) {
    return new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: hashForAlgorithm(alg) },
        key,
        data,
      ),
    );
  }
  if (isHmacAlgorithm(alg)) {
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }
  if (alg === "EdDSA") {
    return new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" } as any,
        key,
        data,
      ),
    );
  }
  throw new AlgorithmNotAllowedError(`unsupported algorithm ${alg}`);
}

export async function generateKeyPairForTest(
  alg: JwsAlgorithm,
): Promise<CryptoKeyPair> {
  if (RSA_ALGORITHMS.has(alg)) {
    return crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: hashForAlgorithm(alg),
      },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  }
  if (EC_ALGORITHMS.has(alg)) {
    return crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: curveForAlgorithm(alg) },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  }
  if (alg === "EdDSA") {
    return crypto.subtle.generateKey(
      { name: "Ed25519" } as any,
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  }
  throw new AlgorithmNotAllowedError(`cannot generate key pair for ${alg}`);
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function curveForAlgorithm(alg: JwsAlgorithm): "P-256" | "P-384" | "P-521" {
  if (alg === "ES384") return "P-384";
  if (alg === "ES512") return "P-521";
  return "P-256";
}
type KeyUse = "sign" | "verify";
