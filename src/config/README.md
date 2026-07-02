# `forge/config`

Schema-validated, fail-fast configuration with native secret redaction. The boring infrastructure layer for the most boring problem in software: making sure your app actually has a `DB_URL` before it starts answering requests.

Most config libraries (`dotenv`, `convict`, `node-config`) ship a runtime-typed bag of strings and trust your reviewers to spot bad coercions. `forge/config` is the opposite:

- **Schema-driven.** Declare leaves with `t.string` / `t.url` / `t.port` / `t.enum([...])`. Types are inferred end-to-end — `config.app.port` is `number`, never `string | undefined`.
- **Fail-fast.** A missing or invalid value renders a high-signal table to stderr and `process.exit(1)`. No malformed configuration ever reaches a request handler.
- **Twelve-Factor by construction.** Environment variables are the source of truth. `.env` files load only in dev/test — the production environment fence is enforced inside the loader, not by convention.
- **Secret-aware.** `t.secret` and `t.url.secret()` wrap values in `Secret<T>`. Every leak surface (`console.log`, `JSON.stringify`, `util.inspect`, template literals) returns `[REDACTED]` instead of the raw credential.
- **Composable, not monolithic.** `ConfigSource` is a tiny interface. Bring your own AWS SSM / Vault / LaunchDarkly adapter — built-in sources (`env`, `dotenv`, `cli`) are just default implementations.
- **Bun-native.** Uses `Bun.env`, `Bun.file`, `bun:test`. No third-party runtime dependencies.

---

## Shipped today

1. `defineConfig(schema, options?)` — synchronous load → validate → freeze → return.
2. `defineDynamicConfig(schema, options)` — async loader for runtime-mutable values (feature flags, kill switches), with a `Proxy`-backed live view that reflects provider updates atomically.
3. `t` — schema builder with primitives `string`, `number` (+ `int`), `boolean`, `port`, `url`, `email`, `enum`, `secret`, `json<T>()`.
4. `Secret<T>` — leak-resistant wrapper covering every default leak surface.
5. Source stack — built-in `envSource`, `dotenvSource` (auto-disabled in production), `cliSource` (`--app.port=8080` / `--app.port 8080`).
6. Provider stack — `staticProvider` (single-snapshot, useful in tests), `pollingProvider` (BYO `fetch` + `intervalMs`, wraps LaunchDarkly / AppConfig / DB feeds).
7. Diagnostics — aggregating box-drawn table renderer + `writeFailFast` (stderr + `exit(1)`).
8. Observability — `defineConfig({ logger })` and `defineDynamicConfig({ logger })` emit structured boot-summary + dynamic-update lines via a **structurally-typed** `Logger`. No hard dependency on `forge/telemetry/log`.
9. Testing — `mockConfig` (ALS-scoped overrides), `recordingProvider`, conformance scenarios for BYO provider implementations.
10. Error taxonomy — `ConfigError` base + `ConfigValidationError` (with structured `issues[]`), `ConfigSourceError`, `ConfigSchemaError`, `ConfigSecretAccessError`, `ConfigProviderError`, `ConfigFrozenError`.

Current boundary: built-in file support is `.env` only, and the config APIs are read-only. General JSON/YAML/TOML file sources and write/update persistence are intentionally not shipped today.

---

## Module layout

```
src/config/
├── index.ts                          # public surface
├── types.ts                          # ConfigSchema, Infer<S>
├── errors.ts                         # ConfigError + subclasses + ConfigDiagnostic
├── secret.ts                         # Secret<T>
├── define.ts                         # defineConfig + defaultSources
│
├── schema/
│   ├── index.ts                      # t, Leaf, isLeaf, ...
│   ├── types.ts                      # Leaf<T>, LeafParseResult
│   ├── builder.ts                    # t.*
│   ├── walk.ts                       # collectLeaves, pathToEnvVar, deepFreeze
│   └── primitives/{string,number,boolean,port,url,email,enum,secret,json}.ts
│
├── sources/
│   ├── index.ts
│   ├── types.ts                      # ConfigSource interface
│   ├── env.ts                        # Bun.env / process.env
│   ├── dotenv.ts                     # .env (production-disabled)
│   └── cli.ts                        # process.argv
│
├── diagnostics/
│   ├── index.ts
│   ├── format.ts                     # box-drawn table renderer
│   └── stderr.ts                     # writeFailFast
│
├── dynamic/
│   ├── index.ts                      # defineDynamicConfig, diff
│   ├── define.ts                     # defineDynamicConfig
│   ├── diff.ts                       # snapshot diff helper
│   └── proxy.ts                      # live-view proxy
│
├── providers/
│   ├── index.ts
│   ├── types.ts                      # DynamicConfigProvider interface
│   ├── static.ts                     # staticProvider
│   └── polling.ts                    # pollingProvider
│
├── testing/
│   ├── index.ts                      # public test helpers
│   ├── mock.ts                       # ALS-scoped overrides
│   ├── context.ts                    # override context internals
│   ├── conformance.ts                # provider conformance scenarios
│   └── recording-provider.ts         # controllable provider for tests
│
├── logger.ts                         # Logger interface (structural)
├── mockable.ts                       # static config override proxy
├── observability.ts                  # boot-summary + dynamic-update emitters
├── overrides.ts                      # override resolution helpers
└── validate.ts                       # shared static + dynamic validator core
```

---

## Quick start

```ts
import { defineConfig, t } from "forge/config";

export const config = defineConfig({
  app: {
    name: t.string.default("forge-app"),
    env: t.enum(["development", "staging", "production"] as const).required(),
    port: t.port.default(3000),
  },
  db: {
    url: t.url.required(),
  },
  cache: {
    redisUrl: t.url.optional(),
  },
  auth: {
    jwtSecret: t.secret.required(),
  },
  features: {
    rollout: t.json<{ readonly newCheckout: boolean }>().default({ newCheckout: false }),
  },
});

// All types are inferred end-to-end:
//   config.app.port         → number
//   config.app.env          → "development" | "staging" | "production"
//   config.db.url           → URL
//   config.cache.redisUrl   → URL | undefined
//   config.auth.jwtSecret   → Secret<string>
//   config.features.rollout → { readonly newCheckout: boolean }
```

If any required value is missing or fails its parser, the process never reaches the export — `defineConfig` prints the diagnostic table to stderr and exits.

---

## Loading order

Sources are queried lowest-priority first; the highest-priority source that returns a defined value wins.

1. **Schema defaults** — `t.string.default("x")`. Used only when no source has a value.
2. **`.env` files** — automatically disabled when the resolved environment is `"production"`. Intended for dev/test only.
3. **Environment variables** — `Bun.env` (falls back to `process.env`). The 12-Factor source of truth.
4. **CLI arguments** — `--app.port=8080` or `--app.port 8080`. Accepts the dotted path or the env-var form.

There is no built-in JSON/YAML/TOML config-file loader or write API. Use a custom `ConfigSource` / `DynamicConfigProvider` when a deployment needs those.

The environment is resolved from `options.environment` → `APP_ENV` → `NODE_ENV` → `"development"`.

---

## The `t` builder

| Primitive          | Coercion                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| `t.string`         | Trims whitespace.                                                       |
| `t.string.url`     | Validates URL shape, returns string.                                    |
| `t.string.email`   | Validates email shape, returns string.                                  |
| `t.number`         | Parses float. Rejects `NaN`, `Infinity`, trailing garbage.              |
| `t.number.int`     | Same, but requires `Number.isInteger`.                                  |
| `t.boolean`        | Accepts `true` / `false` / `1` / `0` / `yes` / `no` (any casing).       |
| `t.port`           | Integer in `[1, 65535]`.                                                |
| `t.url`            | Parses into native `URL`.                                               |
| `t.url.secret()`   | Parses URL, wraps in `Secret` (for connection strings with credentials).|
| `t.email`          | Alias for `t.string.email`.                                             |
| `t.enum([...])`    | One of a fixed string set; literal inference preserved.                 |
| `t.secret`         | Wraps the raw value in `Secret<string>`.                                |
| `t.json<T>()`      | `JSON.parse` + cast to `T`.                                             |

All leaves chain `.default(value)`, `.required()`, `.optional()`, `.env(name)`.

---

## Diagnostic table

When boot validation fails, `defineConfig` renders one row per offending leaf:

```
❌ Forge Configuration Error: Invalid environment variables.
┌────────────────┬────────────┬──────────────────────────────────────────┐
│ Variable       │ Status     │ Reason                                   │
├────────────────┼────────────┼──────────────────────────────────────────┤
│ APP_ENV        │ ❌ Missing │ Must be one of: development, staging,    │
│                │            │ production.                              │
├────────────────┼────────────┼──────────────────────────────────────────┤
│ DB_URL         │ ❌ Invalid │ Invalid URL.                             │
└────────────────┴────────────┴──────────────────────────────────────────┘

Process exited with code 1.
```

Every issue is collected before failing — the table never short-circuits on the first error. The boot operator sees the entire surface of misconfiguration in one go.

---

## Secret redaction

```ts
import { defineConfig, Secret, t } from "forge/config";

const config = defineConfig({
  auth: { jwtSecret: t.secret.required() },
});

console.log(config.auth.jwtSecret);
// → Secret <[REDACTED]>

JSON.stringify(config.auth);
// → '{"jwtSecret":"[REDACTED]"}'

`token=${config.auth.jwtSecret}`;
// → 'token=[REDACTED]'

config.auth.jwtSecret.unwrap();
// → 'super-secret-api-key'  ← the only path that returns the raw value
```

The `unwrap()` site is grep-able, which makes credential handling auditable. Diagnostics never echo the raw value of a leaf marked secret.

---

## Immutability

`defineConfig` deep-freezes its return value before handing it back. The **shape** of the tree is locked:

```ts
config.app = { …};                 // TypeError in strict mode
delete (config as any).db;         // TypeError in strict mode
config.app.port = 99;              // TypeError in strict mode
```

Two carve-outs exist because of how `Object.freeze` works in V8/JavaScriptCore — both are inherent limitations of the runtime, not bugs in `forge/config`:

- **`URL` instances stay internally mutable.** A `URL`'s components live on accessor properties on `URL.prototype`, not own data properties, so `Object.freeze` cannot lock them. `config.db.url.pathname = "/x"` will still mutate the live `URL`. If you need a tamper-proof connection target, snapshot the string form (`config.db.url.toString()`) at the consumption site or wrap it in `t.url.secret()` so accidental logs redact rather than leak.
- **`Secret`'s wrapped value stays in a private field.** `Object.freeze` cannot reach the `#value` slot. The `Secret` wrapper itself is frozen (no properties can be added), but the private slot is unreachable from outside the class anyway — `unwrap()` is the only way to read it, and there is no setter.

For the boot-time fail-fast use case `forge/config` is built around, this is the right trade-off: the tree itself cannot be re-shaped mid-request, and `URL` / `Secret` semantics match what an application developer already expects from those types.

---

## Bring-your-own source

`ConfigSource` is a two-method interface — easy to implement for AWS SSM, HashiCorp Vault, GCP Secret Manager, or an in-memory fixture during tests:

```ts
import { defineConfig, defaultSources, t } from "forge/config";
import type { ConfigSource } from "forge/config";

const ssm: ConfigSource = {
  name: "aws-ssm",
  get({ envVar }) {
    return ssmCache.get(`/myapp/${envVar.toLowerCase()}`);
  },
};

export const config = defineConfig(schema, {
  sources: [
    ...defaultSources(process.env.APP_ENV ?? "development"),
    ssm,  // highest priority — wins over env / cli / .env when present
  ],
});
```

Sources are queried highest-priority-first; the first defined value wins.

---

## Dynamic configuration

For runtime-mutable values — feature flags, kill switches, traffic ramps — use `defineDynamicConfig`. The returned handle exposes a `values` proxy that always reads through to the **most recently validated and deep-frozen** snapshot:

```ts
import { defineDynamicConfig, pollingProvider, t } from "forge/config";

const flags = await defineDynamicConfig(
  {
    features: {
      newCheckout: t.boolean.default(false),
      maintenanceMode: t.boolean.default(false),
    },
    limits: { maxUploadSizeMb: t.number.default(10) },
  },
  {
    provider: pollingProvider({
      name: "app-config",
      intervalMs: 30_000,
      fetch: async (signal) => {
        const res = await fetch("https://flags.example.com/snapshot", { signal });
        return await res.json() as Record<string, string>;
      },
    }),
    onChange(_old, _next, changedKeys) {
      log.warn("dynamic config updated", { changed: changedKeys });
    },
  },
);

// Anywhere in the request path — no re-call needed:
if (flags.values.features.maintenanceMode) {
  return res.json({ error: "maintenance" });
}
```

### Provider contract

`DynamicConfigProvider` is the minimum a feed has to implement:

```ts
interface DynamicConfigProvider {
  readonly name: string;
  get(): DynamicConfigSnapshot | Promise<DynamicConfigSnapshot>;
  subscribe(handler: (snapshot: DynamicConfigSnapshot) => void): () => void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

A `DynamicConfigSnapshot` is `Record<string, string>` keyed by **dotted schema path** (`"features.newCheckout"`), not env-var name — dynamic feeds think in product-shaped namespaces. Built-in implementations:

- **`staticProvider(snapshot)`** — single-shot snapshot; never fires updates. Perfect for tests.
- **`pollingProvider({ name, fetch, intervalMs, signal?, onError? })`** — generic polling loop; consumers wrap it for any backing store. Errors from `fetch` and from handlers are isolated via `onError`; the loop keeps running.

The library deliberately does **not** ship concrete LaunchDarkly / AppConfig / SSM / Vault providers — those belong in the application layer, where credential handling and SDK choice are already decided.

### Validation & atomic swap

Every provider update is validated through the same pipeline as `defineConfig`. Three outcomes:

1. **Identical to the previous snapshot** — no swap, no `onChange` call, no log line. Polling providers can emit duplicates without producing phantom updates.
2. **Valid + changed** — the validated tree is deep-frozen, the proxy's backing ref is atomically swapped, `onChange(old, new, changedKeys)` fires (errors isolated by default), and a `warn`-level `Dynamic config updated` line is emitted to the optional logger with `changed_keys`.
3. **Invalid** — the live view is preserved (the previous valid snapshot stays in effect), and the error is surfaced via the logger. Set `propagateProviderErrors: true` to receive a `ConfigProviderError` on the next `flush()` / `shutdown()` instead.

### Reading dynamic config

The proxy reads through to `ref.current` on every access, so accessing `flags.values.x.y` always returns the latest:

```ts
flags.values.features.maintenanceMode; // always the latest snapshot
```

If you **capture a nested subtree into a local variable**, that local variable is pinned to the snapshot in effect at the time of capture — the local references the frozen plain object that `setAtPath` produced for that snapshot. This is the right semantics for request handlers (a single request should see a consistent view), but it does mean you should reach for `flags.values` at the top of each access if you need the latest:

```ts
const pinned = flags.values.features;   // captures snapshot v1
provider.push(/* v2 */);
pinned.maintenanceMode;                  // still the v1 value
flags.values.features.maintenanceMode;   // the v2 value
```

### Lifecycle

`defineDynamicConfig` returns a handle with `flush()`, `shutdown()`, and `[Symbol.asyncDispose]`. `shutdown()` unsubscribes the handler, calls `provider.shutdown?()`, and is safe to call more than once. TypeScript 5.2+ users can `await using flags = await defineDynamicConfig(…)` to get automatic teardown.

---

## Observability

Pass an `options.logger` to either `defineConfig` or `defineDynamicConfig` to receive structured log lines:

```ts
defineConfig(schema, { logger: log });
// → info "Configuration loaded successfully" {
//     module: "forge/config",
//     boot_time_ms: 4,
//     sources: ["dotenv", "env", "cli"],
//     loaded_keys: ["app.name", "app.port", "db.url", …],
//     redacted_keys: ["auth.token", …],
//   }
```

The `Logger` parameter is **structurally typed** — any object with `info` / `warn` / `error` methods that accept `(msg, attrs)` works, including `console`. `forge/config` deliberately does *not* import from `forge/telemetry/log`, so the module stays free of a hard telemetry dependency.

Field semantics:

- **`loaded_keys`** — every dotted path the validator placed into the tree, including:
  - leaves whose raw value was parsed from a source,
  - leaves that fell back to a `.default(…)` value, and
  - `.optional()` leaves left as `undefined`. These are tree positions the loader decided on; they appear in the list even though the runtime value is `undefined`.

  If you want "keys with a defined runtime value" specifically, filter against the tree at the call site.

- **`redacted_keys`** — the subset of `loaded_keys` that carried a `Secret`-typed value (parsed-from-source or applied-from-default). `.optional()` leaves left as `undefined` never appear here because there is no secret value to mask.

- **Both arrays carry paths only, never values** — secrets cannot leak through the boot summary.

---

## Testing

`forge/config/testing` provides async-scoped static overrides plus a
provider-author conformance suite.

```ts
import { defineConfig, t } from "forge/config";
import { mockConfig } from "forge/config/testing";

const config = defineConfig({
  app: { port: t.port.default(3000) },
});

await mockConfig({ app: { port: 8080 } }, async () => {
  config.app.port; // 8080 inside this async scope
});

config.app.port; // 3000 after the scope settles
```

`mockConfig` uses `AsyncLocalStorage`, so overrides do not mutate env
vars or module globals. Nested mocks compose with last write wins, and
the override scope is popped even when the callback throws.

Provider authors can validate custom dynamic feeds with the same
contract used by the built-ins:

```ts
import {
  assertProviderConformance,
  recordingProvider,
} from "forge/config/testing";

await assertProviderConformance(() => {
  const provider = recordingProvider({ "features.enabled": "false" });
  return {
    provider,
    emit(snapshot) {
      provider.push(snapshot);
    },
  };
});
```

The standard scenarios cover `get()` idempotence, subscription order,
`flush()` draining, `shutdown()` teardown, unsubscribe behavior, and
isolation between subscriber failures.

---

## Why not `dotenv` / `convict` / `zod`?

| Concern                           | `dotenv` | `convict` | `zod`        | `forge/config` |
| --------------------------------- | -------- | --------- | ------------ | -------------- |
| Type inference from schema        | ❌       | partial   | ✅           | ✅             |
| Fail-fast at boot                 | ❌       | ✅        | not built-in | ✅             |
| Deep-freeze the result            | ❌       | ❌        | ❌           | ✅             |
| Secret redaction primitive        | ❌       | ❌        | ❌           | ✅             |
| Twelve-Factor production fence    | ❌       | ❌        | ❌           | ✅             |
| Aggregated diagnostic table       | ❌       | ❌        | partial      | ✅             |
| Zero runtime dependencies         | ✅       | ❌        | ✅           | ✅             |
| Pluggable sources (SSM / Vault)   | ❌       | partial   | n/a          | ✅             |

`forge/config` is purpose-built for the operational reality of a 12-Factor service — boot succeeds with a known-good config, or it doesn't boot at all.
