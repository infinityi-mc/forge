import { Secret, isSecret } from "../../config/secret";
import type { AuditLogger } from "../audit/types";
import { KeyResolutionError } from "../errors";
import {
  importHmacSecret,
  importJwkForVerify,
  isHmacAlgorithm,
} from "../jwt/algorithms";
import type { JwsAlgorithm } from "../jwt/types";
import type {
  CounterLike,
  SecurityTelemetry,
  UpDownCounterLike,
} from "../types";
import type {
  FetchLike,
  HealthResult,
  JsonWebKey,
  JsonWebKeySet,
  JwksCacheOptions,
  KeyStore,
} from "./types";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MIN_REFETCH_INTERVAL_MS = 30 * 1000;

interface CachedJwks {
  readonly jwks: JsonWebKeySet;
  readonly expiresAt: number;
}

export function staticKeyStore(jwks: JsonWebKeySet): KeyStore {
  validateJwks(jwks);
  const cache = new Map<string, Promise<CryptoKey>>();

  return {
    async resolve(kid, alg) {
      if (isHmacAlgorithm(alg)) {
        throw new KeyResolutionError(
          "HMAC algorithms cannot be verified with a JWKS key",
        );
      }
      const jwk = findJwk(jwks, kid, alg);
      const key = cacheKey(jwk, alg);
      let imported = cache.get(key);
      if (imported === undefined) {
        imported = importJwkForVerify(jwk, alg);
        cache.set(key, imported);
      }
      return imported;
    },
    async health() {
      return healthy();
    },
  };
}

export function hmacKeyStore(secret: Secret<string>): KeyStore {
  if (!isSecret(secret)) {
    throw new KeyResolutionError("hmacSecret must be a Secret<string>");
  }
  const cache = new Map<JwsAlgorithm, Promise<CryptoKey>>();

  return {
    async resolve(_kid, alg) {
      if (!isHmacAlgorithm(alg)) {
        throw new KeyResolutionError(
          "asymmetric algorithms cannot be verified with an HMAC secret",
        );
      }
      let imported = cache.get(alg);
      if (imported === undefined) {
        imported = importHmacSecret(secret, alg, "verify");
        cache.set(alg, imported);
      }
      return imported;
    },
    async health() {
      return healthy();
    },
  };
}

export interface CreateJwksKeyStoreOptions {
  readonly jwksUri: string;
  readonly cache?: JwksCacheOptions;
  readonly fetch?: FetchLike;
  /** Opt-in observability — emits `security.jwks.refetch` + `cache.size`. */
  readonly telemetry?: SecurityTelemetry;
  /** Always-on audit logger — records `auth.key.rotated` on rotation. */
  readonly audit?: AuditLogger;
}

export function createJwksKeyStore(options: CreateJwksKeyStoreOptions): KeyStore {
  if (options.jwksUri.trim() === "") {
    throw new KeyResolutionError("jwksUri is required");
  }

  const fetchLike = options.fetch ?? globalThis.fetch;
  if (typeof fetchLike !== "function") {
    throw new KeyResolutionError("fetch is not available");
  }

  const ttlMs = options.cache?.ttlMs ?? DEFAULT_TTL_MS;
  const minRefetchIntervalMs =
    options.cache?.minRefetchIntervalMs ?? DEFAULT_MIN_REFETCH_INTERVAL_MS;
  const refetchCounter: CounterLike | undefined =
    options.telemetry?.meter?.createCounter?.("security.jwks.refetch", {
      description: "JWKS refetch attempts (detects rotation storms)",
    });
  const cacheSizeCounter: UpDownCounterLike | undefined =
    options.telemetry?.meter?.createUpDownCounter?.("security.jwks.cache.size", {
      description: "Cached JWKS verification keys",
    });
  const audit = options.audit;
  let cached: CachedJwks | undefined;
  let lastFetchAt = 0;
  let inFlight: Promise<void> | undefined;
  let knownKids = new Set<string>();
  let cacheSize = 0;

  async function fetchJwks(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && cached !== undefined && cached.expiresAt > now) return;
    if (
      !force &&
      cached !== undefined &&
      now - lastFetchAt < minRefetchIntervalMs
    ) {
      return;
    }
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }

    inFlight = (async () => {
      let response: Response;
      try {
        response = await runFetch(options.cache, () => fetchLike(options.jwksUri));
        if (!response.ok) {
          throw new KeyResolutionError(
            `JWKS fetch failed with HTTP ${response.status}`,
          );
        }
      } catch (error) {
        refetchCounter?.add(1, { outcome: "failure" });
        throw error;
      }
      const body = await response.json();
      const jwks = normalizeJwks(body);
      const maxAgeMs = cacheControlMaxAgeMs(response.headers.get("cache-control"));
      cached = {
        jwks,
        expiresAt: Date.now() + (maxAgeMs ?? ttlMs),
      };
      lastFetchAt = Date.now();
      refetchCounter?.add(1, { outcome: "success" });
      onJwksRefreshed(jwks);
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  }

  function onJwksRefreshed(jwks: JsonWebKeySet): void {
    const nextKids = new Set<string>();
    for (const key of jwks.keys) {
      if (typeof key.kid === "string") nextKids.add(key.kid);
    }
    const rotatedIn = [...nextKids].filter((kid) => !knownKids.has(kid));
    const hadKeys = knownKids.size > 0;
    knownKids = nextKids;

    const nextSize = jwks.keys.length;
    if (nextSize !== cacheSize) {
      cacheSizeCounter?.add(nextSize - cacheSize);
      cacheSize = nextSize;
    }

    if (hadKeys && rotatedIn.length > 0 && audit !== undefined) {
      void audit
        .record({
          action: "auth.key.rotated",
          outcome: "success",
          metadata: { kids: rotatedIn },
        })
        .catch(() => undefined);
    }
  }

  return {
    async resolve(kid, alg) {
      if (isHmacAlgorithm(alg)) {
        throw new KeyResolutionError(
          "HMAC algorithms cannot be verified with a JWKS key",
        );
      }
      await fetchJwks(false);
      let jwk = cached === undefined ? undefined : maybeFindJwk(cached.jwks, kid, alg);
      if (jwk === undefined) {
        await fetchJwks(true);
        jwk = cached === undefined ? undefined : maybeFindJwk(cached.jwks, kid, alg);
      }
      if (jwk === undefined) {
        throw new KeyResolutionError(
          kid === undefined ? `no key found for ${alg}` : `no key found for kid ${kid}`,
        );
      }
      return importJwkForVerify(jwk, alg);
    },
    async health(): Promise<HealthResult> {
      try {
        await fetchJwks(cached === undefined || cached.expiresAt <= Date.now());
        return healthy();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: "unhealthy", message, checkedAt: new Date() };
      }
    },
  };
}

async function runFetch<T>(
  cache: JwksCacheOptions | undefined,
  op: () => Promise<T>,
): Promise<T> {
  if (cache?.resilience !== undefined) {
    return cache.resilience.execute(op);
  }
  return op();
}

function findJwk(jwks: JsonWebKeySet, kid: string | undefined, alg: JwsAlgorithm): JsonWebKey {
  const jwk = maybeFindJwk(jwks, kid, alg);
  if (jwk === undefined) {
    throw new KeyResolutionError(
      kid === undefined ? `no key found for ${alg}` : `no key found for kid ${kid}`,
    );
  }
  return jwk;
}

function maybeFindJwk(
  jwks: JsonWebKeySet,
  kid: string | undefined,
  alg: JwsAlgorithm,
): JsonWebKey | undefined {
  const candidates = kid === undefined
    ? jwks.keys
    : jwks.keys.filter((key) => key.kid === kid);
  return candidates.find((key) =>
    (key.alg === undefined || key.alg === alg) &&
    (key.use === undefined || key.use === "sig") &&
    keyOpsAllowVerify(key)
  );
}

function keyOpsAllowVerify(jwk: JsonWebKey): boolean {
  if (jwk.key_ops === undefined) return true;
  return Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify");
}

function cacheKey(jwk: JsonWebKey, alg: JwsAlgorithm): string {
  return `${jwk.kid ?? JSON.stringify(jwk)}:${alg}`;
}

function validateJwks(jwks: JsonWebKeySet): void {
  if (!Array.isArray(jwks.keys)) {
    throw new KeyResolutionError("JWKS must contain a keys array");
  }
}

function normalizeJwks(value: unknown): JsonWebKeySet {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { keys?: unknown }).keys)
  ) {
    throw new KeyResolutionError("JWKS response must contain a keys array");
  }
  return { keys: (value as { keys: JsonWebKey[] }).keys };
}

function cacheControlMaxAgeMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(header);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]) * 1000;
}

function healthy(): HealthResult {
  return { status: "healthy", checkedAt: new Date() };
}
