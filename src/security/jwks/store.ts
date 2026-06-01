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
const DEFAULT_FETCH_TIMEOUT_MS = 5 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

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

export function createJwksKeyStore(
  options: CreateJwksKeyStoreOptions,
): KeyStore {
  if (options.jwksUri.trim() === "") {
    throw new KeyResolutionError("jwksUri is required");
  }

  const allowInsecureHttp = options.cache?.allowInsecureHttp === true;
  const allowedHosts = options.cache?.allowedHosts;
  const allowRedirects = options.cache?.allowRedirects === true;
  const timeoutMs = options.cache?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxResponseBytes =
    options.cache?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (allowRedirects && allowedHosts === undefined) {
    throw new KeyResolutionError("allowRedirects requires allowedHosts");
  }
  assertAllowedJwksUrl(options.jwksUri, { allowInsecureHttp, allowedHosts });

  const fetchLike = options.fetch ?? globalThis.fetch;
  if (typeof fetchLike !== "function") {
    throw new KeyResolutionError("fetch is not available");
  }

  const ttlMs = options.cache?.ttlMs ?? DEFAULT_TTL_MS;
  const minRefetchIntervalMs =
    options.cache?.minRefetchIntervalMs ?? DEFAULT_MIN_REFETCH_INTERVAL_MS;
  const negativeKidTtlMs =
    options.cache?.negativeKidTtlMs ?? minRefetchIntervalMs;
  const refetchCounter: CounterLike | undefined =
    options.telemetry?.meter?.createCounter?.("security.jwks.refetch", {
      description: "JWKS refetch attempts (detects rotation storms)",
    });
  const unknownKidCounter: CounterLike | undefined =
    options.telemetry?.meter?.createCounter?.("security.jwks.unknown_kid", {
      description: "Unknown JWT kid misses that may trigger JWKS refetches",
    });
  const cacheSizeCounter: UpDownCounterLike | undefined =
    options.telemetry?.meter?.createUpDownCounter?.(
      "security.jwks.cache.size",
      {
        description: "Cached JWKS verification keys",
      },
    );
  const audit = options.audit;
  let cached: CachedJwks | undefined;
  let lastFetchAt = 0;
  let inFlight: Promise<void> | undefined;
  let knownKids = new Set<string>();
  let cacheSize = 0;
  // Time of the last refetch attempt forced by an unknown `kid`. Repeated or
  // distinct unknown `kid`s are throttled against this so an attacker cannot
  // turn a stream of unknown `kid`s into a stream of outbound JWKS fetches,
  // including when the JWKS endpoint is failing.
  let lastUnknownKidRefetchAt = 0;
  // Remembers `(kid, alg)` pairs confirmed-missing by a successful refetch, so
  // repeats stay local until the negative TTL expires.
  const negativeKidCache = new Map<string, number>();

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
      try {
        const fetched = await runFetch(options.cache, () =>
          fetchJsonWithLimits(
            fetchLike,
            options.jwksUri,
            {
              timeoutMs,
              allowRedirects,
              allowInsecureHttp,
              allowedHosts,
            },
            maxResponseBytes,
          ),
        );
        const jwks = normalizeJwks(fetched.body);
        const maxAgeMs = cacheControlMaxAgeMs(fetched.cacheControl);
        cached = {
          jwks,
          expiresAt: Date.now() + (maxAgeMs ?? ttlMs),
        };
        lastFetchAt = Date.now();
        refetchCounter?.add(1, { outcome: "success" });
        onJwksRefreshed(jwks);
      } catch (error) {
        refetchCounter?.add(1, { outcome: "failure" });
        throw error;
      }
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  }

  function sweepExpiredNegativeKids(now: number): void {
    for (const [key, expiresAt] of negativeKidCache) {
      if (expiresAt <= now) negativeKidCache.delete(key);
    }
  }

  function onJwksRefreshed(jwks: JsonWebKeySet): void {
    const nextKids = new Set<string>();
    for (const key of jwks.keys) {
      if (typeof key.kid === "string") nextKids.add(key.kid);
    }
    const rotatedIn = [...nextKids].filter((kid) => !knownKids.has(kid));
    const hadKeys = knownKids.size > 0;
    knownKids = nextKids;

    // New keys are available — drop remembered misses so a freshly rotated
    // kid resolves immediately instead of waiting out its negative TTL.
    if (rotatedIn.length > 0) negativeKidCache.clear();

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
      let jwk =
        cached === undefined ? undefined : maybeFindJwk(cached.jwks, kid, alg);
      if (jwk === undefined) {
        const missKey = `${kid ?? "*"}:${alg}`;
        const now = Date.now();
        sweepExpiredNegativeKids(now);
        const negativeUntil = negativeKidCache.get(missKey);
        const negativeHit = negativeUntil !== undefined && negativeUntil > now;
        const throttled = now - lastUnknownKidRefetchAt < minRefetchIntervalMs;
        if (!negativeHit && !throttled) {
          // Treat an unknown kid as a possible rotation, but allow only one
          // such forced refetch per throttle window. The throttle advances in
          // `finally` so it moves on failure too (a JWKS outage must not turn
          // into a per-request fetch amplifier) while concurrent callers still
          // coalesce onto the in-flight fetch before the window closes.
          unknownKidCounter?.add(1, { outcome: "refetch_attempt" });
          try {
            await fetchJwks(true);
          } finally {
            lastUnknownKidRefetchAt = Date.now();
          }
          jwk =
            cached === undefined
              ? undefined
              : maybeFindJwk(cached.jwks, kid, alg);
          if (jwk === undefined) {
            negativeKidCache.set(missKey, Date.now() + negativeKidTtlMs);
          }
        }
      }
      if (jwk === undefined) {
        throw new KeyResolutionError(
          kid === undefined
            ? `no key found for ${alg}`
            : `no key found for kid ${kid}`,
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

interface UrlPolicy {
  readonly allowInsecureHttp: boolean;
  readonly allowedHosts?: readonly string[];
}

function assertAllowedJwksUrl(uri: string, policy: UrlPolicy): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new KeyResolutionError("jwksUri is not a valid URL");
  }
  if (
    url.protocol !== "https:" &&
    !(policy.allowInsecureHttp && url.protocol === "http:")
  ) {
    throw new KeyResolutionError("jwksUri must use https");
  }
  if (
    policy.allowedHosts !== undefined &&
    !policy.allowedHosts.includes(url.host)
  ) {
    throw new KeyResolutionError(`jwksUri host ${url.host} is not allowed`);
  }
}

interface FetchPolicy {
  readonly timeoutMs: number;
  readonly allowRedirects: boolean;
  readonly allowInsecureHttp: boolean;
  readonly allowedHosts?: readonly string[];
}

interface FetchedJson {
  readonly body: unknown;
  readonly cacheControl: string | null;
}

async function fetchJsonWithLimits(
  fetchLike: FetchLike,
  uri: string,
  policy: FetchPolicy,
  maxResponseBytes: number,
): Promise<FetchedJson> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const response = await fetchLike(uri, {
      signal: controller.signal,
      redirect: policy.allowRedirects ? "follow" : "error",
    });
    if (!response.ok) {
      throw new KeyResolutionError(
        `JWKS fetch failed with HTTP ${response.status}`,
      );
    }
    validateRedirectTarget(response, policy);
    const body = await readJsonWithCap(
      response,
      maxResponseBytes,
      controller.signal,
    );
    return { body, cacheControl: response.headers.get("cache-control") };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new KeyResolutionError("JWKS fetch timed out", { cause: error });
    }
    if (error instanceof KeyResolutionError) throw error;
    throw new KeyResolutionError("JWKS fetch failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function validateRedirectTarget(response: Response, policy: FetchPolicy): void {
  if (!policy.allowRedirects) return;
  if (policy.allowedHosts === undefined) {
    throw new KeyResolutionError("allowRedirects requires allowedHosts");
  }
  if (response.url === "") {
    throw new KeyResolutionError("JWKS final URL could not be validated");
  }
  assertAllowedJwksUrl(response.url, {
    allowInsecureHttp: policy.allowInsecureHttp,
    allowedHosts: policy.allowedHosts,
  });
}

async function readJsonWithCap(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    throw new KeyResolutionError("JWKS response exceeds maximum size");
  }
  const text = await readBodyWithCap(response, maxResponseBytes, signal);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new KeyResolutionError("JWKS response is not valid JSON", {
      cause: error,
    });
  }
}

/**
 * Read the body incrementally and abort as soon as the accumulated byte count
 * exceeds the cap, so a body that omits or lies about `Content-Length` cannot
 * force us to buffer an unbounded response. Falls back to `text()` only when
 * the runtime exposes no readable stream.
 */
async function readBodyWithCap(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null || typeof body.getReader !== "function") {
    const text = await readFallbackText(response, signal);
    if (new TextEncoder().encode(text).length > maxResponseBytes) {
      throw new KeyResolutionError("JWKS response exceeds maximum size");
    }
    return text;
  }
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new KeyResolutionError("JWKS response exceeds maximum size");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readFallbackText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let abort: (() => void) | undefined;
  try {
    const text = await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new KeyResolutionError("JWKS fetch timed out"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    throwIfAborted(signal);
    return text;
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new KeyResolutionError("JWKS fetch timed out");
}

function findJwk(
  jwks: JsonWebKeySet,
  kid: string | undefined,
  alg: JwsAlgorithm,
): JsonWebKey {
  const jwk = maybeFindJwk(jwks, kid, alg);
  if (jwk === undefined) {
    throw new KeyResolutionError(
      kid === undefined
        ? `no key found for ${alg}`
        : `no key found for kid ${kid}`,
    );
  }
  return jwk;
}

function maybeFindJwk(
  jwks: JsonWebKeySet,
  kid: string | undefined,
  alg: JwsAlgorithm,
): JsonWebKey | undefined {
  const candidates =
    kid === undefined ? jwks.keys : jwks.keys.filter((key) => key.kid === kid);
  return candidates.find(
    (key) =>
      (key.alg === undefined || key.alg === alg) &&
      (key.use === undefined || key.use === "sig") &&
      keyOpsAllowVerify(key),
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
