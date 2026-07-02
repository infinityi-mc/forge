# Forge — Complete API Surface Guide

> This document covers **every public runtime API** across all 8 modules.
> For usage patterns and quick-start, see [README.md](./README.md).

---

## Table of Contents

1. [Config](#1-config) — Schema-validated, fail-fast configuration
2. [Data](#2-data) — Type-safe SQL, pooling, multi-tenancy
3. [HTTP](#3-http) — Client, server, middleware, OpenAPI
4. [Lifecycle](#4-lifecycle) — Boot, shutdown, health probes
5. [Messaging](#5-messaging) — Pub/sub, inbox, dead-letter, outbox, jobs
6. [Resilience](#6-resilience) — Retry, timeout, circuit breaker, rate limit, bulkhead, fallback, hedge
7. [Security](#7-security) — JWT/API-key verification, authorization, audit, JWKS
8. [Telemetry](#8-telemetry) — Logging, metrics, tracing, context propagation

---

## 1. Config

```ts
import {
  defineConfig,
  defineDynamicConfig,
  defaultSources,
  diff,
  t,
  Secret,
  isSecret,
  pollingProvider,
  staticProvider,
  cliSource,
  dotenvSource,
  envSource,
  formatDiagnostics,
  writeFailFast,
  // Errors
  ConfigError,
  ConfigFrozenError,
  ConfigProviderError,
  ConfigSchemaError,
  ConfigSecretAccessError,
  ConfigSourceError,
  ConfigValidationError,
} from "@infinityi/forge/config";
```

### `defineConfig(schema, options?): Infer<S>`

Load, validate, and deep-freeze configuration from environment/CLI/dotenv at boot.

```ts
import { defineConfig, t } from "@infinityi/forge/config";

export const config = defineConfig({
  app: {
    name: t.string.default("forge-app"),
    env: t.enum(["development", "staging", "production"]).required(),
    port: t.port.default(3000),
    debug: t.boolean.default(false),
  },
  db: {
    url: t.url.required(),
    poolMax: t.number.int.default(10),
  },
  auth: {
    jwtSecret: t.secret.required(),
    adminEmail: t.email.required(),
  },
  features: t.json<{ darkMode: boolean }>(),
});

// config.app.port       → number
// config.db.url         → URL
// config.auth.jwtSecret → Secret<string>
```

**`DefineConfigOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sources` | `ConfigSource[]` | dotenv → env → CLI | Override the source stack (lowest-priority first) |
| `throwOnError` | `boolean` | `false` | Throw instead of exit(1) on validation failure |
| `environment` | `string` | `APP_ENV` / `NODE_ENV` / `"development"` | Override resolved environment |
| `redactReceived` | `boolean` | `true` in production | Suppress raw values in diagnostics |
| `logger` | `Logger` | — | Structured logger for boot summary |
| `diagnostics` | `object` | — | Override stderr/exit/color/width |

### Schema Builder (`t`)

| Leaf | Parsed Type | Chainable Methods |
|------|-------------|-------------------|
| `t.string` | `string` | `.required()`, `.default(v)`, `.env("VAR")`, `.optional()` |
| `t.number` | `number` | `.int`, `.required()`, `.default(v)`, `.env("VAR")` |
| `t.boolean` | `boolean` | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.port` | `number` (1–65535) | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.url` | `URL` | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.email` | `string` | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.enum(variants)` | union of `variants` | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.secret` | `Secret<string>` | `.required()`, `.default(v)`, `.env("VAR")` |
| `t.json<T>()` | `T` | `.required()`, `.default(v)`, `.env("VAR")` |

### `Secret<T>`

Leak-resistant wrapper for credentials.

```ts
import { Secret, isSecret } from "@infinityi/forge/config";

const s = new Secret("my-key");
s.unwrap();        // "my-key"
String(s);         // "[REDACTED]"
JSON.stringify(s); // '"[REDACTED]"'
isSecret(s);       // true
```

| Method | Description |
|--------|-------------|
| `unwrap(): T` | Return the raw value |
| `toString(): string` | `"[REDACTED]"` |
| `toJSON(): string` | `"[REDACTED]"` |

### `defineDynamicConfig(schema, options): DynamicConfigHandle<S>`

Runtime-mutable configuration backed by a provider that returns raw string snapshots keyed by dotted schema path.

```ts
import { defineDynamicConfig, t, pollingProvider } from "@infinityi/forge/config";

const handle = await defineDynamicConfig(
  { featureFlags: { darkMode: t.boolean.default(false) } },
  {
    provider: pollingProvider({
      name: "feature-flags",
      intervalMs: 30_000,
      fetch: async () => ({ "featureFlags.darkMode": "true" }),
    }),
    onChange(oldCfg, newCfg, changedKeys) {
      console.log("changed:", changedKeys);
    },
  },
);

handle.values.featureFlags.darkMode; // live value
await handle.shutdown();
```

**`DynamicConfigHandle<S>`**

| Member | Description |
|--------|-------------|
| `values: Infer<S>` | Live proxy view (always latest snapshot) |
| `flush(): Promise<void>` | Drain pending updates |
| `shutdown(): Promise<void>` | Stop provider and release resources |
| `[Symbol.asyncDispose]` | Automatic teardown via `await using` |

### `diff(a, b): string[]`

Return dotted paths that differ between two config snapshots.

```ts
import { diff } from "@infinityi/forge/config";

diff({ a: { x: 1 } }, { a: { x: 2 } }); // ["a.x"]
```

### Providers

| Factory | Description |
|---------|-------------|
| `staticProvider(options)` | Single fixed snapshot; useful for tests |
| `pollingProvider(options)` | Fetch + subscribe loop at `intervalMs` |

### Sources

| Factory | Description |
|---------|-------------|
| `envSource(options?)` | Read from `process.env` / `Bun.env` |
| `dotenvSource(options?)` | Parse `.env` file (disabled in production) |
| `cliSource(options?)` | Parse `--key=value` CLI flags |
| `defaultSources(env)` | Build the default stack for a given env |

Built-in file support is limited to `.env`. General config files and write/update persistence require a custom source/provider.

### Diagnostics

```ts
import { formatDiagnostics, writeFailFast } from "@infinityi/forge/config";

const formatted = formatDiagnostics(issues, { color: true, width: 80 });
writeFailFast(issues, { stderr: process.stderr, exit: process.exit });
```

---

## 2. Data

```ts
import {
  createDb,
  createPool,
  expectUpdated,
  raw,
  sql,
  // Errors
  ConcurrencyError,
  DataError,
  MigrationError,
  PoolError,
  QueryError,
  TenantError,
  TransactionError,
} from "@infinityi/forge/data";
```

### `createDb(options): Db<Schema>`

Create a typed database handle.

```ts
import { createDb } from "@infinityi/forge/data";
import { postgresDialect } from "@infinityi/forge/data/dialects/postgres";

interface MySchema {
  users: { id: string; name: string; tenant_id: string };
  orders: { id: string; user_id: string; total: number; tenant_id: string };
}

const db = createDb<MySchema>({
  dialect: postgresDialect,
  driver: myPostgresDriver,
  telemetry: { meter, tracer },
  outbox: { table: "_forge_outbox" },
});
```

### `Db<Schema>` — The Database Handle

| Method | Description |
|--------|-------------|
| `selectFrom(table)` | Start a SELECT query builder |
| `insertInto(table)` | Start an INSERT query builder |
| `updateTable(table)` | Start an UPDATE query builder |
| `deleteFrom(table)` | Start a DELETE query builder |
| `raw(fragment)` | Execute raw SQL via `sql` tagged template |
| `execute(compiled)` | Execute a pre-compiled query |
| `uow(fn, options?)` | Run `fn` inside a transaction (Unit of Work) |
| `withTenant(id, opts?)` | Return a tenant-scoped handle |
| `ping()` | Health-check the connection |
| `shutdown()` | Release driver resources |

### Query Builders

#### SELECT

```ts
const users = await db
  .selectFrom("users")
  .select(["id", "name"])
  .where("tenant_id", "=", "t1")
  .orderBy("name", "asc")
  .limit(10)
  .execute();

// users.rows → Array<{ id: string; name: string }>
```

#### INSERT

```ts
const inserted = await db
  .insertInto("users")
  .values({ id: "u1", name: "Alice", tenant_id: "t1" })
  .returningAll()
  .executeTakeFirstOrThrow();
```

#### UPDATE

```ts
const result = await db
  .updateTable("users")
  .set({ name: "Bob" })
  .where("id", "=", "u1")
  .execute();

// result.numAffectedRows → bigint
```

#### DELETE

```ts
await db
  .deleteFrom("orders")
  .where("user_id", "=", "u1")
  .execute();
```

### Raw SQL

```ts
import { sql, raw } from "@infinityi/forge/data";

const fragment = sql`SELECT * FROM users WHERE id = ${userId}`;
const result = await db.raw<{ id: string; name: string }>(fragment).execute();
```

`raw(text)` produces an unescaped SQL fragment (for identifiers/operators):

```ts
const col = raw("created_at");
const query = sql`SELECT * FROM orders ORDER BY ${col} DESC`;
```

### Transactions (Unit of Work)

```ts
const order = await db.uow(async (tx) => {
  const o = await tx
    .insertInto("orders")
    .values({ id: "o1", user_id: "u1", total: 99, tenant_id: "t1" })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Transactional outbox — write atomically with business data
  await tx.outbox.publish("order.created", { orderId: o.id });
  return o;
}, { isolationLevel: "serializable", retries: 3 });
```

**`UowOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `isolationLevel` | `"read committed"` \| `"repeatable read"` \| `"serializable"` | DB default | Transaction isolation |
| `retries` | `number` | `0` | Number of retry attempts on conflict |
| `shouldRetry` | `(error, attempt) => boolean` | — | Custom retry predicate |

### Multi-Tenancy

```ts
const tenantDb = db.withTenant("tenant-123", { column: "tenant_id" });

// All queries auto-filter on tenant_id = 'tenant-123'
const rows = await tenantDb.selectFrom("users").select(["id", "name"]).execute();
```

### `expectUpdated(result, expected?)`

Assert `numAffectedRows` matches (defaults to 1). Throws `ConcurrencyError` otherwise.

```ts
import { expectUpdated } from "@infinityi/forge/data";

const result = await db.updateTable("users").set({ name: "X" }).where("id", "=", "u1").execute();
expectUpdated(result); // throws if 0 rows updated
```

### `createPool(options): Pool<Resource>`

Generic async resource pool.

```ts
import { createPool } from "@infinityi/forge/data";

const pool = createPool({
  name: "pg",
  max: 10,
  min: 2,
  create: () => createConnection(),
  destroy: (conn) => conn.close(),
  validate: (conn) => conn.isAlive(),
  acquireTimeoutMs: 5_000,
});

const lease = await pool.acquire();
try {
  await doWork(lease.resource);
} finally {
  lease.release();
}

pool.stats(); // { total, idle, active, waiters }
await pool.drain();
```

**`PoolOptions<R>`**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `max` | `number` | yes | Maximum pool size |
| `min` | `number` | no (0) | Minimum idle resources |
| `create` | `() => Promise<R>` | yes | Factory for new resources |
| `destroy` | `(r) => Promise<void>` | no | Cleanup on eviction |
| `validate` | `(r) => boolean` | no | Health check before lease |
| `acquireTimeoutMs` | `number` | no | Max wait time for a lease |
| `name` | `string` | no | Pool identifier for metrics |
| `telemetry` | `object` | no | Meter for pool gauges/histograms |

---

## 3. HTTP

```ts
import {
  // Client
  createHttpClient,
  // Server
  createRouter,
  serve,
  compose,
  createHttpRequest,
  routeMetadata,
  // Middleware
  requestId,
  accessLog,
  cors,
  bodyLimit,
  rateLimit,
  auth,
  problemDetails,
  telemetryMiddleware,
  validate,
  // OpenAPI
  buildOpenApi,
  serveOpenApi,
  problemSchema,
  // Codec
  jsonCodec,
  // Problem Details
  problem,
  ProblemError,
  renderProblem,
  normalizeProblem,
  PROBLEM_CONTENT_TYPE,
  DEFAULT_PROBLEM_TYPE,
  // Errors
  HttpError,
  RequestError,
  ResponseError,
  TimeoutError,
  RouteConflictError,
  ValidationError,
  OpenApiError,
} from "@infinityi/forge/http";
```

### Client — `createHttpClient(options): HttpClient`

Resilient, traced HTTP client.

```ts
import { createHttpClient } from "@infinityi/forge/http";
import { combine, retry, timeout, exponentialBackoff } from "@infinityi/forge/resilience";

const api = createHttpClient({
  baseUrl: "https://payments.internal",
  timeoutMs: 2_000,
  resilience: combine(
    retry({ maxAttempts: 3, backoff: exponentialBackoff() }),
    timeout({ ms: 2_000 }),
  ),
  telemetry, // traced fetch with W3C propagation
});

// Methods
const user = await api.get<User>("/users/123");
const created = await api.post<Order>("/orders", { items: ["a"] });
const updated = await api.put<Order>("/orders/1", { status: "shipped" });
const patched = await api.patch<Order>("/orders/1", { note: "rush" });
await api.delete("/orders/1");
```

**`HttpClientOptions`**

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | `string` | Base URL for all requests |
| `timeoutMs` | `number` | Default request timeout |
| `resilience` | `Pipeline` | `@infinityi/forge/resilience` pipeline |
| `headers` | `Record<string, string>` | Default headers |
| `codec` | `Codec` | Request/response codec (default JSON) |
| `telemetry` | `object` | Tracer for distributed tracing |
| `fetch` | `FetchLike` | Override the underlying fetch |

### Server — `createRouter(options?): Router`

Segment-trie router with typed routes.

```ts
import { createRouter, serve } from "@infinityi/forge/http";

const router = createRouter()
  .use(requestId())
  .use(telemetryMiddleware({ telemetry }))
  .use(problemDetails())
  .use(cors({ origin: "*" }))
  .get("/health", () => new Response("ok"))
  .get("/users/:id", async (req) => {
    const user = await findUser(req.params.id);
    return Response.json(user);
  })
  .post("/users", async (req) => {
    const body = await req.json();
    const user = await createUser(body);
    return Response.json(user, { status: 201 });
  });

const server = serve({ router, port: 3000 });
// server.stop() for graceful shutdown
```

#### Typed Routes with Schema Validation

```ts
import { createRouter, validate } from "@infinityi/forge/http";

const router = createRouter()
  .route({
    method: "POST",
    path: "/users",
    summary: "Create a user",
    tags: ["users"],
    request: {
      body: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" } },
        required: ["name", "email"],
      },
    },
    responses: {
      201: { description: "Created" },
      400: { description: "Validation error" },
    },
    handler: validate(async (req) => {
      // req.body is typed and validated
      const user = await createUser(req.body);
      return Response.json(user, { status: 201 });
    }),
  });
```

#### `serve(options): HttpServer`

```ts
const server = serve({
  router,
  port: 3000,
  hostname: "0.0.0.0",
});

await server.stop(); // graceful shutdown
```

#### `compose(...middlewares): Middleware`

Fold multiple middleware into one (outermost-first).

```ts
const stack = compose(requestId(), cors(), accessLog({ logger }));
```

### Built-in Middleware

| Factory | Description |
|---------|-------------|
| `requestId(opts?)` | Propagate/generate `x-request-id` |
| `accessLog(opts?)` | Structured log per request |
| `cors(opts?)` | Standards-compliant CORS |
| `bodyLimit(opts?)` | Reject oversized request bodies |
| `rateLimit(opts?)` | Per-route rate limiting |
| `auth(opts?)` | Bearer token authentication |
| `problemDetails(opts?)` | Render errors as RFC 7807 |
| `telemetryMiddleware(opts?)` | Span-per-request + metrics |
| `validate(opts?)` | Schema-validate request body/params/query |

#### `cors(options?)`

```ts
router.use(cors({
  origin: ["https://app.example.com"],
  methods: ["GET", "POST"],
  credentials: true,
  maxAge: 3600,
}));
```

#### `bodyLimit(options?)`

```ts
router.use(bodyLimit({ maxBytes: 1_048_576 })); // 1 MB
```

#### `rateLimit(options?)`

```ts
router.use(rateLimit({
  limiter: myLimiter, // from @infinityi/forge/resilience
  keyExtractor: (req) => req.headers.get("x-api-key") ?? req.ip,
}));
```

### OpenAPI 3.1 Generation

```ts
import { buildOpenApi, serveOpenApi, problemSchema } from "@infinityi/forge/http";

const doc = buildOpenApi(router, {
  info: { title: "My API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
});

// Serve as middleware (GET /openapi.json)
router.use(serveOpenApi(router, {
  info: { title: "My API", version: "1.0.0" },
  path: "/openapi.json",
}));

// Standard problem schema for error responses
const errSchema = problemSchema(); // RFC 7807 JSON Schema
```

### Problem Details (RFC 7807)

```ts
import { problem, ProblemError, renderProblem, PROBLEM_CONTENT_TYPE } from "@infinityi/forge/http";

// Throw a problem from a handler
throw problem(404, {
  title: "Not Found",
  detail: "User u1 does not exist",
  instance: "/users/u1",
});

// Render any error as an RFC 7807 Response
const response = renderProblem(error);
```

---

## 4. Lifecycle

```ts
import {
  forge,
  boot,
  asComponent,
  realClock,
  // Adapters
  databaseComponent,
  httpServerComponent,
  messageBusComponent,
  consumerComponent,
  poolComponent,
  relayComponent,
  workerComponent,
  // Health
  createProbe,
  healthRoutes,
  startHealthServer,
  // Signals
  installSignalHandlers,
  // Errors
  ComponentRegistrationError,
  HealthCheckError,
  LifecycleError,
  ShutdownError,
  ShutdownTimeoutError,
  StartupError,
} from "@infinityi/forge/lifecycle";
```

### `forge.boot(options)` / `boot(options): Promise<Application>`

Start components in order, fail-fast with rollback, graceful shutdown.

```ts
import { forge, asComponent } from "@infinityi/forge/lifecycle";

const app = await forge.boot({
  components: [
    asComponent("db", {
      start: () => db.ping(),
      stop: () => db.shutdown(),
      healthcheck: () => db.ping(),
    }),
    asComponent("http", {
      start: () => { server = serve({ router, port: 3000 }); },
      stop: () => server.stop(),
    }),
  ],
  shutdownTimeout: 30_000,
  startTimeout: 15_000,
  preStopDelayMs: 5_000,
  logger,
  telemetry,
});

// app.ready   → boolean
// app.stop()  → trigger graceful shutdown
// app.done    → resolves after shutdown completes
await app.done;
```

**`BootOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `components` | `Component[]` | required | Ordered component list |
| `shutdownTimeout` | `number` | `30_000` | Max ms for full shutdown |
| `startTimeout` | `number` | = shutdownTimeout | Max ms per component start |
| `preStopDelayMs` | `number` | `0` | Delay before stopping (drain) |
| `installSignals` | `boolean` | `true` | Install SIGTERM/SIGINT handlers |
| `logger` | `Logger` | — | Structured logger |
| `telemetry` | `object` | — | Lifecycle metrics/tracing |
| `clock` | `Clock` | `realClock` | Override clock for tests |
| `exit` | `(code) => void` | `process.exit` | Override exit behavior |

### `asComponent(name, hooks): Component`

Wrap a plain object into a named component.

```ts
const comp = asComponent("cache", {
  start: async () => { await redis.connect(); },
  stop: async () => { await redis.quit(); },
  healthcheck: async () => {
    await redis.ping();
    return { status: "healthy" };
  },
});
```

**`ComponentHooks`**

| Hook | Description |
|------|-------------|
| `start()` | Called during boot (may be async) |
| `stop()` | Called during shutdown (reverse order) |
| `healthcheck()` | Readiness check, called by probes |

### Built-in Adapters

Pre-built components for common Forge primitives:

```ts
import {
  databaseComponent,
  httpServerComponent,
  messageBusComponent,
  consumerComponent,
  poolComponent,
  relayComponent,
  workerComponent,
} from "@infinityi/forge/lifecycle";

// Database adapter
databaseComponent("db", db, { healthcheck: true });

// HTTP server adapter
httpServerComponent("api", server);

// Message bus adapter
messageBusComponent("events", bus);

// Consumer adapter
consumerComponent("order-handler", consumer);

// Pool adapter
poolComponent("pg-pool", pool);

// Outbox relay adapter
relayComponent("outbox", relay);

// Background worker adapter
workerComponent("jobs", worker);
```

### Health Probes

```ts
import { createProbe, startHealthServer, healthRoutes } from "@infinityi/forge/lifecycle";

const probe = createProbe({
  ready: () => app.ready,
  checks: [
    { name: "db", check: () => db.ping() },
    { name: "redis", check: () => redis.ping() },
  ],
});

// Option A: standalone health server on a separate port
const healthServer = startHealthServer(probe, { port: 9000 });

// Option B: mount on your existing router
const routes = healthRoutes(probe);
router.get("/healthz", routes.liveness);
router.get("/readyz", routes.readiness);
```

**Endpoints**

| Path | Description |
|------|-------------|
| `GET /healthz` | Liveness — always 200 if process is alive |
| `GET /readyz` | Readiness — 200 only when all checks pass |

### Signal Handling

```ts
import { installSignalHandlers } from "@infinityi/forge/lifecycle";

installSignalHandlers({
  onShutdown: () => app.stop(),
  signals: ["SIGTERM", "SIGINT"],
});
```

---

## 5. Messaging

```ts
import {
  createMessageBus,
  createConsumer,
  jsonCodec,
  // Errors
  HandlerError,
  IdempotencyError,
  JobError,
  MessageDroppedError,
  MessagingError,
  OutboxRelayError,
  SerializationError,
  TransportError,
} from "@infinityi/forge/messaging";
```

### `createMessageBus(options): MessageBus`

The publish side.

```ts
import { createMessageBus } from "@infinityi/forge/messaging";
import { inMemoryTransport } from "@infinityi/forge/messaging/transports/memory";

const transport = inMemoryTransport();
const bus = createMessageBus({
  transport,
  defaultHeaders: { source: "order-service" },
  telemetry,
  logger,
});

// Single publish
await bus.publish({
  type: "order.placed",
  payload: { orderId: "123", total: 99 },
});

// Batch publish
await bus.publishBatch([
  { type: "order.placed", payload: { orderId: "1" } },
  { type: "order.placed", payload: { orderId: "2" } },
]);
```

**`MessageBusOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `Transport` | required | Underlying broker |
| `codec` | `Codec` | `jsonCodec()` | Encode/decode payloads |
| `defaultHeaders` | `Record<string, string>` | `{}` | Headers merged into every message |
| `idGenerator` | `() => string` | `crypto.randomUUID` | Message ID factory |
| `telemetry` | `MessagingTelemetry` | — | Metrics and tracing |
| `logger` | `Logger` | — | Structured logger |

### `createConsumer(options): MessageConsumer`

The consume side with dedup, retry, and dead-lettering.

```ts
import { createConsumer } from "@infinityi/forge/messaging";
import { retry, exponentialBackoff } from "@infinityi/forge/resilience";
import { inMemoryInboxStore } from "@infinityi/forge/messaging/inbox";
import { inMemoryDeadLetterStore } from "@infinityi/forge/messaging/deadletter";

const consumer = createConsumer({
  transport,
  topic: "order.placed",
  concurrency: 4,
  inbox: inMemoryInboxStore(),
  inboxClaimTtlMs: 60_000,
  retry: retry({ maxAttempts: 5, backoff: exponentialBackoff() }),
  deadLetter: inMemoryDeadLetterStore(),
  handler: async (msg, ctx) => {
    console.log(msg.type, msg.payload);
    // msg.id, msg.headers, msg.occurredAt
  },
  telemetry,
  logger,
});

await consumer.start();
// …later
await consumer.stop();
```

**`ConsumerOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `Transport` | required | Source broker |
| `topic` | `string` | required | Topic to subscribe to |
| `concurrency` | `number` | `1` | Parallel message processing |
| `handler` | `MessageHandler` | required | Process each message |
| `inbox` | `InboxStore` | — | Dedup store (exactly-once) |
| `inboxClaimTtlMs` | `number` | — | TTL for in-flight claims |
| `retry` | `RetryPolicyLike` | — | Per-message retry policy |
| `deadLetter` | `DeadLetterStore` | — | DLQ for exhausted messages |
| `codec` | `Codec` | `jsonCodec()` | Payload codec |
| `telemetry` | `MessagingTelemetry` | — | Metrics/tracing |
| `logger` | `Logger` | — | Structured logger |

### Transports

```ts
// In-memory (tests / single-process)
import { inMemoryTransport } from "@infinityi/forge/messaging/transports/memory";
const transport = inMemoryTransport({ maxDeliveries: 16 });

// SQLite (durable, single-node)
import { sqliteTransport } from "@infinityi/forge/messaging/transports/sqlite";
const transport = sqliteTransport({ path: "./messages.db" });

// PostgreSQL (multi-node)
import { postgresTransport } from "@infinityi/forge/messaging/transports/postgres";
const transport = postgresTransport({ connectionString: "..." });
```

**Transport interface:**

| Method | Description |
|--------|-------------|
| `send(records)` | Publish encoded records |
| `subscribe(sub)` | Subscribe to a topic, returns `TransportHandle` |
| `shutdown()` | Close the transport |

### Inbox (Deduplication)

```ts
import { inMemoryInboxStore } from "@infinityi/forge/messaging/inbox";
import { sqliteInboxStore } from "@infinityi/forge/messaging/inbox";

// In-memory (tests)
const inbox = inMemoryInboxStore();

// SQLite (durable)
const inbox = sqliteInboxStore({ path: "./inbox.db" });
```

**`InboxStore` interface:**

| Method | Returns | Description |
|--------|---------|-------------|
| `begin(key, opts?)` | `"new"` \| `"duplicate"` \| `"in-flight"` | Claim a message |
| `commit(key)` | `void` | Mark as processed |
| `release(key)` | `void` | Free the claim |

### Dead-Letter Store

```ts
import { inMemoryDeadLetterStore } from "@infinityi/forge/messaging/deadletter";
import { sqliteDeadLetterStore } from "@infinityi/forge/messaging/deadletter";

const dlq = inMemoryDeadLetterStore();

// List failed messages
const entries = await dlq.list({ limit: 10 });

// Redrive a message back to its topic
await dlq.redrive("msg-id", bus);

// Remove from DLQ
await dlq.remove("msg-id");
```

**`DeadLetterStore` interface:**

| Method | Description |
|--------|-------------|
| `store(entry)` | Park a failed message |
| `list(opts?)` | List DLQ entries (newest first) |
| `redrive(id, bus)` | Re-publish to the original topic |
| `remove(id)` | Delete from DLQ |

### Outbox Relay

```ts
import { createOutboxRelay } from "@infinityi/forge/messaging/outbox";

const relay = createOutboxRelay({
  db,
  bus,
  table: "_forge_outbox",
  pollIntervalMs: 1_000,
  batchSize: 100,
  logger,
  telemetry,
});

await relay.start();
// polls outbox table → publishes to bus → marks dispatched
await relay.drainOnce(); // manual one-shot
await relay.stop();
```

**`OutboxRelayOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `db` | `DbLike` | required | Database handle |
| `bus` | `MessageBus` | required | Publish target |
| `table` | `string` | `"_forge_outbox"` | Outbox table name |
| `pollIntervalMs` | `number` | `1_000` | Polling frequency |
| `batchSize` | `number` | `100` | Rows per poll |
| `retry` | `RetryPolicyLike` | — | Per-row publish retry |
| `logger` | `Logger` | — | Structured logger |
| `telemetry` | `MessagingTelemetry` | — | Metrics |

### Background Jobs

```ts
import { createJobQueue, createWorker, inMemoryJobStore, sqliteJobStore } from "@infinityi/forge/messaging/jobs";

// Queue side
const store = sqliteJobStore({ path: "./jobs.db" });
const queue = createJobQueue({ store });

await queue.enqueue("email.send", { to: "user@example.com" });
await queue.enqueue("report.generate", { id: "r1" }, { runAt: new Date("2025-01-01") });
await queue.every("cleanup.stale", 86_400_000); // recurring daily

// Worker side
const worker = createWorker({
  store,
  concurrency: 4,
  handlers: {
    "email.send": async (job) => { await sendEmail(job.payload); },
    "report.generate": async (job) => { await generateReport(job.payload); },
  },
  deadLetter: inMemoryDeadLetterStore(),
  pollIntervalMs: 100,
  visibilityMs: 30_000,
  logger,
});

await worker.start();
// …later
await worker.stop();
```

**`JobQueue`**

| Method | Description |
|--------|-------------|
| `enqueue(name, payload?, opts?)` | Schedule a one-shot job |
| `every(name, intervalMs, opts?)` | Schedule a recurring job |

**`WorkerOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `JobStore` | required | Job persistence |
| `handlers` | `Record<string, JobHandler>` | — | Named handlers |
| `handler` | `JobHandler` | — | Fallback handler |
| `concurrency` | `number` | `1` | Parallel job execution |
| `retry` | `RetryPolicyLike` | — | Per-attempt retry |
| `deadLetter` | `DeadLetterStore` | — | DLQ for exhausted jobs |
| `visibilityMs` | `number` | `30_000` | Claim TTL |
| `pollIntervalMs` | `number` | `50` | Polling frequency |
| `backoff` | `(attempt) => number` | exponential | Retry delay strategy |
| `logger` | `Logger` | — | Structured logger |

---

## 6. Resilience

```ts
import {
  combine,
  retry,
  timeout,
  circuitBreaker,
  rateLimit,
  bulkhead,
  fallback,
  hedge,
  // Backoff strategies
  exponentialBackoff,
  linearBackoff,
  constantBackoff,
  // Result API
  ok,
  err,
  isOk,
  isErr,
  // Clock
  realClock,
  // Errors
  ResilienceError,
  TransientError,
  RateLimitError,
  RetryExhaustedError,
  TimeoutError,
  CircuitOpenError,
  RateLimitedError,
  BulkheadFullError,
  HedgeCancelledError,
} from "@infinityi/forge/resilience";
```

### `combine(...policies): Pipeline`

Compose policies into a pipeline (outermost-first execution order).

```ts
import { combine, retry, timeout, circuitBreaker, exponentialBackoff } from "@infinityi/forge/resilience";

const pipeline = combine(
  retry({ maxAttempts: 3, backoff: exponentialBackoff({ initial: 100, max: 5_000 }) }),
  circuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 }),
  timeout({ ms: 2_000 }),
);

// Throwing API
const data = await pipeline.execute(async (ctx) => {
  const res = await fetch(url, { signal: ctx.signal });
  if (!res.ok) throw new Error("upstream failure");
  return res.json();
});

// No-throw Result API
const result = await pipeline.executeResult(async (ctx) => {
  return fetch(url, { signal: ctx.signal });
});
if (isOk(result)) console.log(result.value);
if (isErr(result)) console.error(result.error);
```

### `retry(options): RetryPolicy`

Retry failed operations with configurable backoff.

```ts
const policy = retry({
  maxAttempts: 5,
  backoff: exponentialBackoff({ initial: 100, max: 10_000, factor: 2 }),
  shouldRetry: (error) => error instanceof TransientError,
  shouldRetryOnValue: (value) => value.status === 503, // retry on specific values
});
```

**`RetryOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | required | Total attempts (including first) |
| `backoff` | `BackoffStrategy` | — | Delay between attempts |
| `shouldRetry` | `(error) => boolean` | all errors | Error predicate |
| `shouldRetryOnValue` | `(value) => boolean` | — | Retry on returned value |
| `telemetry` | `ResilienceTelemetry` | — | Metrics |
| `clock` | `Clock` | `realClock` | Override for tests |

### Backoff Strategies

```ts
exponentialBackoff({ initial: 100, max: 10_000, factor: 2 });
linearBackoff({ initial: 100, increment: 200 });
constantBackoff(500);
```

### `timeout(options): TimeoutPolicy`

Cancel operations that exceed a deadline.

```ts
const policy = timeout({
  ms: 2_000,
  strategy: "optimistic", // or "pessimistic"
});
```

**`TimeoutOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ms` | `number` | required | Timeout duration |
| `strategy` | `"optimistic"` \| `"pessimistic"` | `"optimistic"` | Cancel behavior |
| `telemetry` | `ResilienceTelemetry` | — | Metrics |
| `clock` | `Clock` | `realClock` | Override for tests |

### `circuitBreaker(options): CircuitBreakerPolicy`

Three-state breaker: closed → open → half-open.

```ts
const breaker = circuitBreaker({
  failureThreshold: 0.5,      // 50% failure ratio trips the breaker
  minimumRequests: 10,         // need 10 samples before ratio can trip
  window: { kind: "time", durationMs: 60_000 },
  resetTimeoutMs: 30_000,      // stay open for 30s
  halfOpenMaxAttempts: 3,      // 3 probe calls in half-open
  shouldTrip: (e) => !(e instanceof ValidationError),
});

// Inspect state
breaker.state;          // "closed" | "open" | "half-open"
breaker.forceOpen();    // incident response
breaker.forceClosed();  // manual recovery
breaker.reset();        // clear history
```

### `rateLimit(options): RateLimitPolicy`

Token-bucket or sliding-window rate limiting.

```ts
// Token bucket (burst-capable)
const limiter = rateLimit({
  algorithm: { kind: "token-bucket", tokensPerSecond: 100, burst: 200 },
  mode: "wait",        // queue excess callers
  maxWaiters: 50,      // max queued callers
});

// Sliding window (strict)
const limiter = rateLimit({
  algorithm: { kind: "sliding-window", limit: 1000, windowMs: 60_000 },
  mode: "throw",       // reject immediately
});

// Inspect state
limiter.availableTokens; // current capacity
limiter.pending;         // waiting callers
```

### `bulkhead(options): BulkheadPolicy`

Concurrency limiter with bounded queue.

```ts
const bh = bulkhead({
  maxConcurrent: 10,
  maxQueue: 20,
});

// Inspect state
bh.active; // current in-flight
bh.queued; // waiting callers
```

### `fallback(options): FallbackPolicy`

Provide a substitute result on failure.

```ts
const policy = fallback({
  fallback: (error, ctx) => ({ cached: true, data: getCachedData() }),
  shouldFallback: (error) => error instanceof TimeoutError,
});
```

### `hedge(options): HedgePolicy`

Speculative parallel attempts; first to resolve wins.

```ts
const policy = hedge({
  delay: 200,             // fire second attempt after 200ms
  maxHedgedAttempts: 2,   // at most 2 concurrent attempts
});
```

### Result API (no-throw)

```ts
import { ok, err, isOk, isErr } from "@infinityi/forge/resilience";

const result = await pipeline.executeResult(async (ctx) => {
  return fetchData(ctx.signal);
});

if (isOk(result)) {
  result.value; // success value
}
if (isErr(result)) {
  result.error; // ResilienceError
}
```

### `ExecutionContext`

Every operation receives:

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal` | Scoped to the current execution |
| `attempt` | `number` | 1-based attempt counter |
| `context` | `TelemetryContext?` | Active telemetry context |

---

## 7. Security

```ts
import {
  // JWT & API Keys
  createJwtVerifier,
  createApiKeyVerifier,
  generateApiKey,
  apiKeyFingerprint,
  // Authorization
  authorize,
  allow,
  deny,
  requireRole,
  requireScope,
  requireTenant,
  allOf,
  anyOf,
  not,
  // Audit
  createAuditLogger,
  auditPrincipal,
  hashAuditEvent,
  verifyAuditChain,
  logSink,
  memorySink,
  memoryAuditSink,
  // JWKS
  createJwksKeyStore,
  hmacKeyStore,
  staticKeyStore,
  // HTTP middleware
  authenticate,
  authorizeRoute,
  // Lifecycle
  securityHealthComponent,
  // Errors
  AlgorithmNotAllowedError,
  AuditError,
  AuthenticationError,
  AuthorizationError,
  KeyResolutionError,
  SecurityError,
  TokenClaimError,
  TokenExpiredError,
  TokenInvalidError,
} from "@infinityi/forge/security";
```

### `createJwtVerifier(options): TokenVerifier`

Verify JWT tokens and extract a `Principal`.

```ts
import { createJwtVerifier } from "@infinityi/forge/security";
import { hmacKeyStore } from "@infinityi/forge/security";

const verifier = createJwtVerifier({
  keyStore: hmacKeyStore({ secret: process.env.JWT_SECRET! }),
  issuer: "https://auth.example.com",
  audience: "my-api",
  algorithms: ["HS256"],
  clockToleranceMs: 30_000,
  claims: {
    subject: "sub",
    roles: "realm_access.roles",
    scopes: "scope",
    tenant: "tenant_id",
  },
});

const principal = await verifier.verify(token);
// principal.subject, principal.roles, principal.scopes, principal.tenant
```

**`JwtVerifierOptions`**

| Option | Type | Description |
|--------|------|-------------|
| `keyStore` | `KeyStore` | Key material source |
| `issuer` | `string` | Expected `iss` claim |
| `audience` | `string \| string[]` | Expected `aud` claim |
| `algorithms` | `JwsAlgorithm[]` | Allowed signing algorithms |
| `clockToleranceMs` | `number` | Leeway for exp/nbf checks |
| `claims` | `ClaimMapping` | Map JWT claims → Principal fields |
| `sizeLimits` | `JwtSizeLimits` | Max header/payload sizes |

### `createApiKeyVerifier(options): TokenVerifier`

Verify API keys against a lookup function.

```ts
import { createApiKeyVerifier, generateApiKey, apiKeyFingerprint } from "@infinityi/forge/security";

// Generate a key
const key = generateApiKey(); // "forge_..."

// Fingerprint (for storage / lookup)
const fp = await apiKeyFingerprint(key); // SHA-256 hash

// Verify
const verifier = createApiKeyVerifier({
  lookup: async (fingerprint) => {
    const record = await db.findApiKey(fingerprint);
    if (!record) return null;
    return {
      principal: { subject: record.userId, roles: record.roles, scopes: [], issuer: "api-key" },
      policy: { rateLimit: 1000 },
    };
  },
});

const principal = await verifier.verify(key);
```

### Key Stores (JWKS)

```ts
import { createJwksKeyStore, hmacKeyStore, staticKeyStore } from "@infinityi/forge/security";

// HMAC (symmetric)
const ks = hmacKeyStore({ secret: "my-secret" });

// Static JWK set
const ks = staticKeyStore({ keys: [jwk1, jwk2] });

// Remote JWKS with caching + rotation
const ks = createJwksKeyStore({
  url: "https://auth.example.com/.well-known/jwks.json",
  cache: { ttlMs: 600_000, staleWhileRevalidate: true },
  resilience: pipeline, // @infinityi/forge/resilience pipeline
});
```

### Authorization Policies

```ts
import { authorize, requireRole, requireScope, requireTenant, allOf, anyOf, not } from "@infinityi/forge/security";

// Single policy
const decision = await authorize(requireRole("admin"), {
  principal,
  action: "users:delete",
});
// decision.effect === "allow" | "deny"

// Compose policies
const policy = allOf(
  requireRole("editor", "admin"),
  requireTenant((resource) => resource?.tenantId),
);

// OR composition
const canRead = anyOf(
  requireRole("admin"),
  requireScope("reports:read"),
);

// Negation
const notGuest = not(requireRole("guest"));
```

**Built-in Policies**

| Factory | Description |
|---------|-------------|
| `allow` | Always allow |
| `deny(reason)` | Always deny with a reason |
| `requireRole(...roles)` | Allow if principal has ANY of the roles |
| `requireScope(...scopes)` | Allow if principal has ANY of the scopes |
| `requireTenant(extractor)` | Allow if principal.tenant matches resource |
| `allOf(...policies)` | All must allow (AND) |
| `anyOf(...policies)` | Any must allow (OR) |
| `not(policy)` | Invert decision |

### HTTP Security Middleware

```ts
import { authenticate, authorizeRoute } from "@infinityi/forge/security";

router
  .use(authenticate({ verifier, audit: auditLogger }))
  .get("/admin/users", authorizeRoute(requireRole("admin"), {
    action: "users:list",
    audit: auditLogger,
    telemetry,
  }), handler);
```

### Audit Logging

```ts
import { createAuditLogger, logSink, memorySink, verifyAuditChain } from "@infinityi/forge/security";

const audit = createAuditLogger({
  sink: logSink({ logger }),
  tamperEvident: true,
  signingSecret: "hmac-key",
  redact: ["metadata.creditCard"],
  correlation: () => requestId,
});

await audit.record({
  action: "user.login",
  outcome: "success",
  principal: { subject: "u1", issuer: "auth" },
  resource: { type: "session", id: "s1" },
  metadata: { ip: "1.2.3.4" },
});

// Verify tamper-evident chain
const result = await verifyAuditChain(events, { signingSecret: "hmac-key" });
// result.valid → boolean
```

**`AuditOptions`**

| Option | Type | Description |
|--------|------|-------------|
| `sink` | `AuditSink` | Where events are persisted |
| `tamperEvident` | `boolean` | Enable hash chaining |
| `signingSecret` | `string` | HMAC key for hashes |
| `redact` | `string[]` | Metadata paths to redact |
| `redactReplacement` | `string` | Replacement text |
| `clock` | `Clock` | Override for tests |
| `correlation` | `() => string` | Correlation ID generator |

### Security Health Component

```ts
import { securityHealthComponent } from "@infinityi/forge/security";

const healthComp = securityHealthComponent({
  keyStore: jwksKeyStore,
  checkIntervalMs: 60_000,
});
// Mount in forge.boot({ components: [..., healthComp] })
```

---

## 8. Telemetry

```ts
import { initTelemetry, TelemetryError } from "@infinityi/forge/telemetry";
import type { Resource, Telemetry } from "@infinityi/forge/telemetry";
```

### `initTelemetry(options): Telemetry`

Unified factory wiring log + meter + trace around a single resource.

```ts
import { initTelemetry } from "@infinityi/forge/telemetry";
import { stdoutLogExporter } from "@infinityi/forge/telemetry/log/exporters/stdout";
import { stdoutMeterExporter } from "@infinityi/forge/telemetry/meter/exporters/stdout";
import { stdoutSpanExporter } from "@infinityi/forge/telemetry/trace/exporters/stdout";

const telemetry = initTelemetry({
  resource: { serviceName: "order-api", serviceVersion: "1.0.0" },
  log: {
    exporter: stdoutLogExporter(),
    level: "info",
    middleware: [],
  },
  meter: {
    exporter: stdoutMeterExporter(),
    intervalMs: 10_000,
  },
  trace: {
    exporter: stdoutSpanExporter(),
    processor: "batch", // or "simple"
  },
});

telemetry.log?.info("ready");
await telemetry.flush();
await telemetry.shutdown();
```

**`Telemetry` handle:**

| Member | Type | Description |
|--------|------|-------------|
| `resource` | `Resource` | Attached resource metadata |
| `log` | `Logger \| undefined` | Logger (if configured) |
| `meter` | `Meter \| undefined` | Meter (if configured) |
| `tracer` | `Tracer \| undefined` | Tracer (if configured) |
| `flush(opts?)` | `Promise<TelemetryFlushResult>` | Drain all signals |
| `shutdown()` | `Promise<TelemetryFlushResult>` | Stop all signals |

### Logging — `@infinityi/forge/telemetry/log`

```ts
import { createLog } from "@infinityi/forge/telemetry/log";
import { stdoutExporter } from "@infinityi/forge/telemetry/log/exporters/stdout";

const log = createLog({
  exporter: stdoutExporter(),
  level: "debug",
  attributes: { service: "api" },
  middleware: [/* redact, enrich, etc. */],
});

log.debug("processing", { orderId: "123" });
log.info("server started", { port: 3000 });
log.warn("slow query", { durationMs: 500 });
log.error("unhandled", { error: serializeError(err) });

// Child loggers inherit + extend attributes
const authLog = log.child({ subsystem: "auth" });
authLog.info("login", { userId: "u1" });

// Lifecycle
await log.flush();
await log.shutdown();
```

**Logger methods:** `debug`, `info`, `warn`, `error` — each takes `(message, attributes?)`.

**Additional:**
- `log.child(attributes)` — Create a scoped child logger
- `log.flush(opts?)` — Drain buffered records
- `log.shutdown()` — Stop accepting records

#### Log Middleware

```ts
import { redact } from "@infinityi/forge/telemetry/log/middleware";

const log = createLog({
  exporter: stdoutExporter(),
  middleware: [redact({ paths: ["user.password", "headers.authorization"] })],
});
```

#### Log Exporters

| Exporter | Import | Description |
|----------|--------|-------------|
| stdout | `@infinityi/forge/telemetry/log/exporters/stdout` | JSON to stdout |
| recording | `@infinityi/forge/telemetry/log/exporters/recording` | In-memory (tests) |
| null | `@infinityi/forge/telemetry/log/exporters/null` | Discard |

### Metrics — `@infinityi/forge/telemetry/meter`

```ts
import { createMeter } from "@infinityi/forge/telemetry/meter";
import { stdoutMeterExporter } from "@infinityi/forge/telemetry/meter/exporters/stdout";

const meter = createMeter({
  resource: { serviceName: "api" },
  exporter: stdoutMeterExporter(),
  intervalMs: 10_000,
  temporality: "delta", // or "cumulative"
});

// Counter
const requests = meter.createCounter("http.requests", {
  description: "Total HTTP requests",
  unit: "1",
});
requests.add(1, { method: "GET", path: "/users" });

// Histogram
const latency = meter.createHistogram("http.duration", {
  description: "Request duration",
  unit: "ms",
  boundaries: [5, 10, 25, 50, 100, 250, 500, 1000],
});
latency.record(42, { method: "POST", path: "/orders" });

// UpDownCounter
const connections = meter.createUpDownCounter("db.connections", {
  description: "Active database connections",
});
connections.add(1);
connections.add(-1);

// Gauge
const queueDepth = meter.createGauge("queue.depth", {
  description: "Current queue depth",
});
queueDepth.record(15, { queue: "emails" });

// Lifecycle
await meter.flush();
await meter.shutdown();
```

**Meter instruments:**

| Factory | Description |
|---------|-------------|
| `createCounter(name, opts?)` | Monotonically increasing value |
| `createHistogram(name, opts?)` | Distribution of values |
| `createUpDownCounter(name, opts?)` | Bidirectional counter |
| `createGauge(name, opts?)` | Point-in-time value |

#### Meter Exporters

| Exporter | Import | Description |
|----------|--------|-------------|
| stdout | `@infinityi/forge/telemetry/meter/exporters/stdout` | JSON to stdout |
| recording | `@infinityi/forge/telemetry/meter/exporters/recording` | In-memory (tests) |
| null | `@infinityi/forge/telemetry/meter/exporters/null` | Discard |

### Tracing — `@infinityi/forge/telemetry/trace`

```ts
import { createTracer, simpleSpanProcessor, batchSpanProcessor } from "@infinityi/forge/telemetry/trace";
import { stdoutSpanExporter } from "@infinityi/forge/telemetry/trace/exporters/stdout";

const tracer = createTracer({
  resource: { serviceName: "api" },
  processor: batchSpanProcessor({
    exporter: stdoutSpanExporter(),
    maxBatchSize: 512,
    scheduledDelayMs: 5_000,
  }),
  sampler: ratioSampler({ ratio: 0.1 }), // sample 10%
});

// Create spans
await tracer.withSpan("checkout", async (span) => {
  span.setAttribute("user.id", userId);
  span.setAttributes({ "order.total": total, "order.items": count });
  span.addEvent("payment.started");

  await charge();

  span.setStatus({ code: "ok" });
});

// Nested spans
await tracer.withSpan("parent", async (parentSpan) => {
  await tracer.withSpan("child", async (childSpan) => {
    childSpan.setAttribute("step", "validation");
  });
});

// Lifecycle
await tracer.flush();
await tracer.shutdown();
```

**Span methods:**

| Method | Description |
|--------|-------------|
| `setAttribute(key, value)` | Set a single attribute |
| `setAttributes(attrs)` | Set multiple attributes |
| `addEvent(name, attrs?)` | Record a timestamped event |
| `setStatus(status)` | Set span status (`"ok"` / `"error"` / `"unset"`) |
| `end(endTime?)` | End the span |

#### Samplers

```ts
import {
  alwaysOnSampler,
  alwaysOffSampler,
  ratioSampler,
  parentBasedSampler,
} from "@infinityi/forge/telemetry/trace";

// Always sample
const sampler = alwaysOnSampler();

// Never sample
const sampler = alwaysOffSampler();

// Probabilistic
const sampler = ratioSampler({ ratio: 0.1 });

// Parent-based (inherit parent decision, fallback to ratio)
const sampler = parentBasedSampler({
  root: ratioSampler({ ratio: 0.05 }),
});
```

#### Span Processors

```ts
// Simple (sync export per span — tests/scripts)
const processor = simpleSpanProcessor({
  exporter: stdoutSpanExporter(),
  propagateExporterErrors: true,
});

// Batch (production — buffers and exports periodically)
const processor = batchSpanProcessor({
  exporter: otlpExporter,
  maxBatchSize: 512,
  scheduledDelayMs: 5_000,
  maxQueueSize: 2048,
});
```

#### Trace Exporters

| Exporter | Import | Description |
|----------|--------|-------------|
| stdout | `@infinityi/forge/telemetry/trace/exporters/stdout` | JSON to stdout |
| recording | `@infinityi/forge/telemetry/trace/exporters/recording` | In-memory (tests) |
| null | `@infinityi/forge/telemetry/trace/exporters/null` | Discard |

### Context Propagation — `@infinityi/forge/telemetry/context`

```ts
import {
  withRootContext,
  withContext,
  currentContext,
  contextStorage,
  extract,
  inject,
  objectCarrier,
  parseTraceparent,
  formatTraceparent,
  parseBaggage,
  formatBaggage,
  genTraceId,
  genSpanId,
} from "@infinityi/forge/telemetry/context";

// Start a root context (entry point of a request)
await withRootContext({ baggage: { tenantId: "t1" } }, async () => {
  const ctx = currentContext();
  // ctx.traceId, ctx.spanId, ctx.baggage
  await handleRequest();
});

// Adopt an extracted context from inbound headers
const ctx = extract(objectCarrier(req.headers));
if (ctx) {
  await withContext(ctx, () => processMessage());
}

// Inject context into outbound headers
const headers: Record<string, string> = {};
inject(objectCarrier(headers));
// headers["traceparent"] = "00-<traceId>-<spanId>-01"
```

### Wire Exporters

#### OTLP/HTTP

```ts
import { otlpHttpLogExporter } from "@infinityi/forge/telemetry/exporters/otlp-http";
import { otlpHttpMeterExporter } from "@infinityi/forge/telemetry/exporters/otlp-http";
import { otlpHttpSpanExporter } from "@infinityi/forge/telemetry/exporters/otlp-http";

const logExporter = otlpHttpLogExporter({ endpoint: "http://collector:4318/v1/logs" });
const meterExporter = otlpHttpMeterExporter({ endpoint: "http://collector:4318/v1/metrics" });
const spanExporter = otlpHttpSpanExporter({ endpoint: "http://collector:4318/v1/traces" });
```

#### Prometheus

```ts
import { prometheusExporter } from "@infinityi/forge/telemetry/exporters/prometheus";

const exporter = prometheusExporter(); // exposes text-format metrics
```

---

## Error Taxonomy

Every module defines a structured error hierarchy rooted at a module-level base class:

| Module | Base Error | Key Subclasses |
|--------|-----------|----------------|
| Config | `ConfigError` | `ConfigValidationError`, `ConfigSchemaError`, `ConfigSourceError`, `ConfigProviderError`, `ConfigFrozenError`, `ConfigSecretAccessError` |
| Data | `DataError` | `QueryError`, `TransactionError`, `ConcurrencyError`, `TenantError`, `PoolError`, `MigrationError` |
| HTTP | `HttpError` | `RequestError`, `ResponseError`, `TimeoutError`, `RouteConflictError`, `ValidationError`, `OpenApiError` |
| Lifecycle | `LifecycleError` | `StartupError`, `ShutdownError`, `ShutdownTimeoutError`, `ComponentRegistrationError`, `HealthCheckError` |
| Messaging | `MessagingError` | `TransportError`, `SerializationError`, `HandlerError`, `IdempotencyError`, `MessageDroppedError`, `OutboxRelayError`, `JobError` |
| Resilience | `ResilienceError` | `RetryExhaustedError`, `TimeoutError`, `CircuitOpenError`, `RateLimitedError`, `BulkheadFullError`, `HedgeCancelledError`, `TransientError`, `RateLimitError` |
| Security | `SecurityError` | `AuthenticationError`, `AuthorizationError`, `TokenInvalidError`, `TokenExpiredError`, `TokenClaimError`, `KeyResolutionError`, `AlgorithmNotAllowedError`, `AuditError` |
| Telemetry | `TelemetryError` | — |

---

## Import Map

All modules are importable via their `@infinityi/forge/<module>` subpath:

```ts
import { ... } from "@infinityi/forge/config";
import { ... } from "@infinityi/forge/data";
import { ... } from "@infinityi/forge/http";
import { ... } from "@infinityi/forge/lifecycle";
import { ... } from "@infinityi/forge/messaging";
import { ... } from "@infinityi/forge/resilience";
import { ... } from "@infinityi/forge/security";
import { ... } from "@infinityi/forge/telemetry";

// Sub-module paths
import { ... } from "@infinityi/forge/telemetry/log";
import { ... } from "@infinityi/forge/telemetry/meter";
import { ... } from "@infinityi/forge/telemetry/trace";
import { ... } from "@infinityi/forge/telemetry/context";
import { ... } from "@infinityi/forge/telemetry/log/exporters/stdout";
import { ... } from "@infinityi/forge/telemetry/meter/exporters/stdout";
import { ... } from "@infinityi/forge/telemetry/trace/exporters/stdout";
import { ... } from "@infinityi/forge/telemetry/exporters/otlp-http";
import { ... } from "@infinityi/forge/telemetry/exporters/prometheus";
import { ... } from "@infinityi/forge/messaging/transports/memory";
import { ... } from "@infinityi/forge/messaging/transports/sqlite";
import { ... } from "@infinityi/forge/messaging/transports/postgres";
import { ... } from "@infinityi/forge/messaging/inbox";
import { ... } from "@infinityi/forge/messaging/deadletter";
import { ... } from "@infinityi/forge/messaging/outbox";
import { ... } from "@infinityi/forge/messaging/jobs";
```
