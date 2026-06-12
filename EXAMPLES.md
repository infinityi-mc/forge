# Forge Examples

This file collects practical use cases for `@infinityi/forge`, ordered from simple single-module snippets to more complete service wiring. The examples assume Bun and strict TypeScript.

> Note: Forge is modular. Import only the subpaths you use; examples intentionally show explicit wiring instead of hidden globals.

## Complexity map

| Level | Use case | Modules covered |
| ---: | --- | --- |
| 1 | Validate boot-time configuration | `config` |
| 2 | Emit structured logs, metrics, and traces | `telemetry` |
| 3 | Wrap flaky I/O with retries and timeouts | `resilience` |
| 4 | Call another service with a resilient HTTP client | `http`, `resilience` |
| 5 | Build a small HTTP API with Problem Details | `http` |
| 6 | Query SQL explicitly without an ORM | `data` |
| 7 | Publish and consume messages reliably | `messaging`, `resilience` |
| 8 | Authenticate and authorize routes | `security`, `http` |
| 9 | Run background jobs | `messaging` |
| 10 | Boot and shut down a service gracefully | `lifecycle`, `http`, `data`, `messaging`, `telemetry` |
| 11 | Atomic business write plus event publication | `data`, `messaging`, `lifecycle` |

---

## 1. Validate boot-time configuration

Use `forge/config` when an application should fail fast if required environment is missing or malformed. Secrets are redacted by default and require explicit `unwrap()` to read.

```ts
// config.ts
import { defineConfig, t } from "@infinityi/forge/config";

export const config = defineConfig({
  app: {
    name: t.string.default("orders-api"),
    env: t.enum(["development", "staging", "production"] as const).required(),
    port: t.port.default(3000),
  },
  db: {
    url: t.url.secret().required(),
  },
  auth: {
    jwtSecret: t.secret.required(),
  },
  features: {
    newCheckout: t.boolean.default(false),
  },
});

// Fully typed:
config.app.port; // number
config.app.env; // "development" | "staging" | "production"
config.db.url; // Secret<URL>
```

Dynamic config is for values that must change at runtime, such as feature flags and maintenance mode.

```ts
import { defineDynamicConfig, pollingProvider, t } from "@infinityi/forge/config";

export const flags = await defineDynamicConfig(
  {
    features: {
      newCheckout: t.boolean.default(false),
      maintenanceMode: t.boolean.default(false),
    },
  },
  {
    provider: pollingProvider({
      name: "feature-flags",
      intervalMs: 30_000,
      fetch: async (signal) => {
        const res = await fetch("https://config.example.com/flags", { signal });
        return await res.json() as Record<string, string>;
      },
    }),
    onChange(_old, _next, changed) {
      console.warn("feature flags changed", changed);
    },
  },
);

if (flags.values.features.maintenanceMode) {
  // reject writes, show a static page, etc.
}
```

---

## 2. Emit structured logs, metrics, and traces

Use `initTelemetry` when a service wants consistent logging, metrics, and tracing behind one shutdown handle.

```ts
import { initTelemetry } from "@infinityi/forge/telemetry";
import { stdoutExporter } from "@infinityi/forge/telemetry/log/exporters/stdout";
import { stdoutMeterExporter } from "@infinityi/forge/telemetry/meter/exporters/stdout";
import { stdoutSpanExporter } from "@infinityi/forge/telemetry/trace/exporters/stdout";

export const telemetry = initTelemetry({
  resource: {
    serviceName: "orders-api",
    serviceVersion: "1.0.0",
    environment: "development",
  },
  log: {
    exporter: stdoutExporter(),
    level: "debug",
  },
  meter: {
    exporter: stdoutMeterExporter(),
    intervalMs: 10_000,
  },
  trace: {
    exporter: stdoutSpanExporter(),
    processor: "batch",
  },
});

telemetry.log?.info("service starting", { port: 3000 });

const requests = telemetry.meter?.createCounter("orders.requests", { unit: "1" });
requests?.add(1, { route: "/orders" });

await telemetry.tracer?.withSpan("orders.create", async (span) => {
  span.setAttribute("tenant.id", "acme");
  // business work here
  span.setStatus({ code: "ok" });
});
```

Propagate request context without passing trace IDs through every function.

```ts
import { withRootContext } from "@infinityi/forge/telemetry/context";

await withRootContext({ baggage: { tenantId: "acme" } }, async () => {
  telemetry.log?.info("processing order");
  // log records and child spans can attach the active trace/baggage.
});
```

---

## 3. Wrap flaky I/O with retries and timeouts

Use `forge/resilience` when calling a dependency that can be slow or transiently unavailable. Always pass `ctx.signal` into cooperative I/O so timeouts cancel real work.

```ts
import {
  TransientError,
  combine,
  exponentialBackoff,
  retry,
  timeout,
} from "@infinityi/forge/resilience";

const dependencyPolicy = combine(
  retry({
    maxAttempts: 3,
    backoff: exponentialBackoff({ initial: 100, max: 2_000 }),
    shouldRetry: (err) => err instanceof TransientError,
  }),
  timeout({ ms: 2_000 }),
);

const user = await dependencyPolicy.execute(async (ctx) => {
  const res = await fetch("https://users.internal/me", { signal: ctx.signal });
  if (res.status >= 500) throw new TransientError("users service failed");
  return await res.json() as { id: string; email: string };
});
```

For no-throw flows, use `executeResult`.

```ts
const result = await dependencyPolicy.executeResult(async (ctx) => {
  const res = await fetch("https://inventory.internal/sku/123", { signal: ctx.signal });
  return await res.json();
});

if (result.isOk()) {
  console.log(result.value);
} else {
  console.error("dependency failed", result.error);
}
```

---

## 4. Call another service with a resilient HTTP client

Use `forge/http` client when you want `fetch` ergonomics plus defaults for base URL, headers, timeouts, resilience, telemetry, and RFC 7807 errors.

```ts
import { createHttpClient } from "@infinityi/forge/http";
import { combine, exponentialBackoff, retry, timeout } from "@infinityi/forge/resilience";
import { telemetry } from "./telemetry";

const payments = createHttpClient({
  baseUrl: "https://payments.internal",
  defaultHeaders: {
    "user-agent": "orders-api/1.0",
  },
  timeoutMs: 2_000,
  resilience: combine(
    retry({ maxAttempts: 3, backoff: exponentialBackoff({ initial: 100, max: 1_000 }) }),
    timeout({ ms: 2_000 }),
  ),
  telemetry: {
    meter: telemetry.meter,
    tracer: telemetry.tracer,
  },
});

const { body: charge } = await payments.post<{ id: string; status: "authorized" | "declined" }>(
  "/charges",
  { orderId: "ord_123", amountCents: 4999 },
);
```

---

## 5. Build a small HTTP API with Problem Details

Use `forge/http` server when you need a thin `Bun.serve()` router with middleware, route params, request validation, OpenAPI metadata, and RFC 7807 error responses.

```ts
import {
  bodyLimit,
  buildOpenApi,
  cors,
  createRouter,
  problemDetails,
  problemSchema,
  requestId,
  serve,
  serveOpenApi,
} from "@infinityi/forge/http";
import { telemetry } from "./telemetry";

const CreateOrder = {
  parse(input: unknown): { sku: string; quantity: number } {
    if (typeof input !== "object" || input === null) throw new Error("body required");
    const body = input as Record<string, unknown>;
    if (typeof body.sku !== "string") throw new Error("sku required");
    if (typeof body.quantity !== "number") throw new Error("quantity required");
    return { sku: body.sku, quantity: body.quantity };
  },
  toJsonSchema() {
    return {
      type: "object",
      required: ["sku", "quantity"],
      properties: {
        sku: { type: "string" },
        quantity: { type: "number", minimum: 1 },
      },
    };
  },
};

const router = createRouter()
  .use(requestId())
  .use(problemDetails({ logger: telemetry.log }))
  .use(cors({ origin: "https://app.example.com" }))
  .use(bodyLimit({ maxBytes: 1_000_000 }))
  .route({
    method: "POST",
    path: "/orders",
    summary: "Create an order",
    tags: ["orders"],
    request: { body: CreateOrder },
    responses: {
      201: { description: "Order created" },
      422: problemSchema("Invalid order request"),
    },
    handler: async (req) => {
      const order = await createOrder(req.locals.body);
      return Response.json(order, { status: 201 });
    },
  })
  .get("/orders/:id", async (req) => {
    const order = await findOrder(req.params.id);
    return order === undefined
      ? new Response(null, { status: 404 })
      : Response.json(order);
  });

const doc = buildOpenApi(router, {
  info: { title: "Orders API", version: "1.0.0" },
  servers: [{ url: "https://orders.example.com" }],
});
router.use(serveOpenApi({ doc })); // GET /openapi.json

const server = serve(router, { port: 3000 });
```

---

## 6. Query SQL explicitly without an ORM

Use `forge/data` for typed SQL query builders, raw SQL, transactions, tenant-scoped handles, and connection lifecycle hooks.

```ts
import { createDb, expectUpdated, sql } from "@infinityi/forge/data";
import { createSqliteDialect, createSqliteDriver } from "@infinityi/forge/data/dialects/sqlite";

type OrderStatus = "pending" | "paid" | "cancelled";

interface AppDb {
  orders: {
    id: string;
    tenant_id: string;
    sku: string;
    quantity: number;
    status: OrderStatus;
    version: number;
    created_at: string;
  };
}

const db = createDb<AppDb>({
  dialect: createSqliteDialect(),
  driver: createSqliteDriver({ filename: "./orders.db" }),
  outbox: { table: "_forge_outbox" },
});

const tenantDb = db.withTenant("tenant_acme", { column: "tenant_id" });

const recentOrders = await tenantDb
  .selectFrom("orders")
  .select(["id", "sku", "quantity", "status"] as const)
  .where("status", "=", "pending")
  .orderBy("created_at", "desc")
  .limit(20)
  .execute();

const updated = await tenantDb
  .updateTable("orders")
  .set({ status: "paid", version: 2 })
  .where("id", "=", "ord_123")
  .where("version", "=", 1)
  .execute();

expectUpdated(updated, 1); // throws ConcurrencyError when no row matched

const totals = await db.raw<{ tenant_id: string; count: number }>(
  sql`select tenant_id, count(*) as count from orders group by tenant_id`,
).execute();
```

Use `uow()` when the write must be atomic.

```ts
await db.uow(async (tx) => {
  await tx.insertInto("orders").values({
    id: "ord_123",
    tenant_id: "tenant_acme",
    sku: "sku_abc",
    quantity: 2,
    status: "pending",
    version: 1,
    created_at: new Date().toISOString(),
  }).execute();

  await tx.outbox.publish("order.created", {
    orderId: "ord_123",
    tenantId: "tenant_acme",
  });
}, { isolationLevel: "serializable", retries: 2 });
```

---

## 7. Publish and consume messages reliably

Use `forge/messaging` for asynchronous work. Delivery is at-least-once by design; add an inbox store for idempotency and a dead-letter store for poison messages.

```ts
import { createConsumer, createMessageBus } from "@infinityi/forge/messaging";
import { inMemoryDeadLetterStore } from "@infinityi/forge/messaging/deadletter";
import { inMemoryInboxStore } from "@infinityi/forge/messaging/inbox";
import { inMemoryTransport } from "@infinityi/forge/messaging/transports/memory";
import { exponentialBackoff, retry, timeout, combine } from "@infinityi/forge/resilience";

const transport = inMemoryTransport({ maxDeliveries: 16 });
const bus = createMessageBus({ transport });
const deadLetter = inMemoryDeadLetterStore();

const consumer = createConsumer({
  transport,
  topic: "order.created",
  concurrency: 4,
  inbox: inMemoryInboxStore(),
  inboxClaimTtlMs: 60_000,
  retry: combine(
    retry({ maxAttempts: 5, backoff: exponentialBackoff({ initial: 100, max: 5_000 }) }),
    timeout({ ms: 10_000 }),
  ),
  deadLetter,
  handler: async (msg, ctx) => {
    const payload = msg.payload as { orderId: string; tenantId: string };
    await sendConfirmationEmail(payload.orderId, { signal: ctx.signal });
  },
});

await consumer.start();
await bus.publish({
  type: "order.created",
  payload: { orderId: "ord_123", tenantId: "tenant_acme" },
  headers: { source: "orders-api" },
});

// Operational review of poison messages:
const parked = await deadLetter.list({ limit: 10 });
```

---

## 8. Authenticate and authorize routes

Use `forge/security` when routes need token verification, declarative authorization, and audit logging. The middleware is structural, so it mounts into `forge/http` without either module owning the other.

```ts
import { createRouter, problemDetails } from "@infinityi/forge/http";
import {
  allOf,
  authenticate,
  authorizeRoute,
  createAuditLogger,
  createJwtVerifier,
  memoryAuditSink,
  requireScope,
  requireTenant,
} from "@infinityi/forge/security";
import { config } from "./config";

const verifier = createJwtVerifier({
  keys: { hmacSecret: config.auth.jwtSecret },
  issuer: "https://auth.example.com",
  audience: "orders-api",
  algorithms: ["HS256"],
  claimMap: {
    roles: "roles",
    scopes: "scope",
    tenant: "tenant_id",
  },
});

const audit = createAuditLogger({
  sink: memoryAuditSink(),
  tamperEvident: true,
  signingSecret: config.auth.jwtSecret,
});

const readOwnTenantOrder = allOf(
  requireScope("orders:read"),
  requireTenant<{ tenantId: string }>((order) => order?.tenantId),
);

const router = createRouter()
  .use(problemDetails())
  .use(authenticate({ verifier, audit }))
  .get(
    "/tenants/:tenantId/orders/:id",
    authorizeRoute(readOwnTenantOrder, {
      action: "orders:read",
      audit,
      resource: (req) => ({ tenantId: req.params.tenantId }),
    }),
    async (req) => {
      const order = await findTenantOrder(req.params.tenantId, req.params.id);
      return Response.json(order);
    },
  );
```

For API keys instead of JWTs, swap the verifier.

```ts
import { apiKeyFingerprint, createApiKeyVerifier } from "@infinityi/forge/security";

const apiKeyVerifier = createApiKeyVerifier({
  policy: { requirePrefix: "fk_" },
  async lookup(fingerprint) {
    const record = await findApiKeyByFingerprint(fingerprint);
    if (record === undefined) return undefined;
    return {
      fingerprint,
      principal: {
        subject: record.id,
        issuer: "orders-api",
        audience: ["orders-api"],
        roles: record.roles,
        scopes: record.scopes,
        tenant: record.tenantId,
        claims: {},
        issuedAt: new Date(record.createdAt),
        expiresAt: new Date(record.expiresAt),
      },
    };
  },
});

const fingerprint = apiKeyFingerprint("fk_live_example_key_value_32_chars_min");
```

---

## 9. Run background jobs

Use `forge/messaging/jobs` for local or durable background work: enqueue now, schedule for later, or register recurring jobs.

```ts
import {
  createJobQueue,
  createWorker,
  sqliteJobStore,
} from "@infinityi/forge/messaging/jobs";

const store = sqliteJobStore({ filename: "./jobs.db" });
const queue = createJobQueue({ store, defaultMaxAttempts: 8 });

const worker = createWorker({
  store,
  concurrency: 8,
  handlers: {
    "email.send": async (job, ctx) => {
      const payload = job.payload as { to: string; template: string };
      await sendEmail(payload, { signal: ctx.signal });
    },
    "report.daily": async (_job, ctx) => {
      await generateDailyReport({ signal: ctx.signal });
    },
  },
});

await worker.start();

await queue.enqueue("email.send", { to: "customer@example.com", template: "welcome" });
await queue.schedule("email.send", new Date(Date.now() + 60_000), {
  to: "later@example.com",
  template: "reminder",
});
await queue.every("report.daily", 86_400_000);
```

---

## 10. Boot and shut down a service gracefully

Use `forge/lifecycle` when multiple resources must start in dependency order and stop in reverse order under a shutdown budget. This is the typical production shape for an HTTP service with a database, message consumer, health probes, and telemetry.

```ts
import {
  consumerComponent,
  databaseComponent,
  forge,
  httpServerComponent,
  messageBusComponent,
  workerComponent,
} from "@infinityi/forge/lifecycle";
import { serve } from "@infinityi/forge/http";
import { config } from "./config";
import { db } from "./data";
import { router } from "./router";
import { bus, consumer } from "./messaging";
import { worker } from "./jobs";
import { telemetry } from "./telemetry";

const server = serve(router, { port: config.app.port });

const app = await forge.boot({
  config,
  logger: telemetry.log ?? console,
  telemetry: {
    meter: telemetry.meter,
    tracer: telemetry.tracer,
  },
  components: [
    // Start order: db -> bus -> consumer -> worker -> http.
    // Stop order: http -> worker -> consumer -> bus -> db.
    databaseComponent("db", db),
    messageBusComponent("bus", bus),
    consumerComponent("order-consumer", consumer),
    workerComponent("jobs", worker),
    httpServerComponent("http", server),
  ],
  health: { port: 9000 }, // /livez and /readyz
  preStopDelayMs: 5_000,
  startTimeout: 10_000,
  shutdownTimeout: 30_000,
});

app.logger.info("orders service started", { port: server.port });
await app.done;
```

---

## 11. Atomic business write plus event publication

This is the most production-oriented messaging use case: write business state and an outbox row in the same `forge/data` transaction, then let a `forge/messaging` relay publish rows to a durable transport. Consumers use inbox deduplication to tolerate at-least-once delivery.

```ts
import { createDb } from "@infinityi/forge/data";
import { createSqliteDialect, createSqliteDriver } from "@infinityi/forge/data/dialects/sqlite";
import { createConsumer, createMessageBus } from "@infinityi/forge/messaging";
import { createOutboxRelay } from "@infinityi/forge/messaging/outbox";
import { sqliteTransport } from "@infinityi/forge/messaging/transports/sqlite";
import { sqliteInboxStore } from "@infinityi/forge/messaging/inbox";
import { sqliteDeadLetterStore } from "@infinityi/forge/messaging/deadletter";
import { databaseComponent, relayComponent, consumerComponent, forge } from "@infinityi/forge/lifecycle";

interface OrdersDb {
  orders: {
    id: string;
    tenant_id: string;
    total_cents: number;
    status: "pending" | "paid";
    created_at: string;
  };
}

const db = createDb<OrdersDb>({
  dialect: createSqliteDialect(),
  driver: createSqliteDriver({ filename: "./orders.db" }),
  outbox: { table: "_forge_outbox" },
});

const transport = sqliteTransport({ filename: "./messages.db" });
const bus = createMessageBus({ transport });
const relay = createOutboxRelay({
  db,
  bus,
  table: "_forge_outbox",
  pollIntervalMs: 1_000,
  batchSize: 100,
});

const consumer = createConsumer({
  transport,
  topic: "order.placed",
  inbox: sqliteInboxStore({ filename: "./inbox.db" }),
  inboxClaimTtlMs: 60_000,
  deadLetter: sqliteDeadLetterStore({ filename: "./deadletter.db" }),
  handler: async (msg, ctx) => {
    const payload = msg.payload as { orderId: string; tenantId: string; totalCents: number };
    await notifyFulfillment(payload, { signal: ctx.signal });
  },
});

async function placeOrder(input: { orderId: string; tenantId: string; totalCents: number }) {
  await db.uow(async (tx) => {
    await tx.insertInto("orders").values({
      id: input.orderId,
      tenant_id: input.tenantId,
      total_cents: input.totalCents,
      status: "pending",
      created_at: new Date().toISOString(),
    }).execute();

    await tx.outbox.publish("order.placed", {
      orderId: input.orderId,
      tenantId: input.tenantId,
      totalCents: input.totalCents,
    });
  });
}

await forge.boot({
  components: [
    databaseComponent("db", db),
    relayComponent("outbox-relay", relay),
    consumerComponent("order-consumer", consumer),
  ],
  shutdownTimeout: 30_000,
});
```

Why this shape matters:

1. The order row and outbox row commit together.
2. The relay publishes committed outbox rows at least once.
3. The consumer inbox deduplicates redeliveries.
4. Dead-letter storage prevents poison messages from blocking the topic forever.

---

## Testing with in-memory doubles

Most modules ship test doubles or conformance helpers. Keep business logic behind interfaces, then test without sockets, external brokers, or real observability backends.

```ts
import { describe, expect, it } from "bun:test";
import { InMemoryMessageBus } from "@infinityi/forge/messaging/testing";
import { createTestTelemetry } from "@infinityi/forge/telemetry/testing";

describe("placeOrder", () => {
  it("publishes an order event and emits telemetry", async () => {
    const bus = new InMemoryMessageBus();
    const telemetry = createTestTelemetry();

    await placeOrder({ bus, telemetry }, { orderId: "ord_123" });
    await telemetry.flushAll();

    expect(bus.publishedEvents).toContainEqual({
      type: "order.placed",
      payload: { orderId: "ord_123" },
    });
    expect(telemetry.records.some((r) => r.message === "order placed")).toBe(true);
  });
});
```
