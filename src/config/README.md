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

## Shipped today (PR A)

1. `defineConfig(schema, options?)` — synchronous load → validate → freeze → return.
2. `t` — schema builder with primitives `string`, `number` (+ `int`), `boolean`, `port`, `url`, `email`, `enum`, `secret`, `json<T>()`.
3. `Secret<T>` — leak-resistant wrapper covering every default leak surface.
4. Source stack — built-in `envSource`, `dotenvSource` (auto-disabled in production), `cliSource` (`--app.port=8080` / `--app.port 8080`).
5. Diagnostics — aggregating box-drawn table renderer + `writeFailFast` (stderr + `exit(1)`).
6. Error taxonomy — `ConfigError` base + `ConfigValidationError` (with structured `issues[]`), `ConfigSourceError`, `ConfigSchemaError`, `ConfigSecretAccessError`, `ConfigFrozenError`.

Upcoming:

- **PR B** — `defineDynamicConfig` for runtime-mutable feature flags, `staticProvider` + `pollingProvider`, structured boot-summary emission via a structurally-typed `Logger` (no hard dep on `forge/telemetry`).
- **PR C** — `forge/config/testing`: `mockConfig` (ALS-scoped overrides), `recordingProvider`, conformance scenarios for BYO provider implementations.

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
└── diagnostics/
    ├── index.ts
    ├── format.ts                     # box-drawn table renderer
    └── stderr.ts                     # writeFailFast
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
