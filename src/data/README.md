# `forge/data`

`forge/data` is the explicit SQL module for Forge. It is not an ORM:
there is no lazy loading, identity map, entity mutation tracking, or
code-first schema generation. Consumers provide database-generated
TypeScript row types, write explicit queries, and execute them through
an explicit database handle.

## Shipped in PR A

- `createDb` factory with no global singleton.
- `sql` tagged template for parameterized raw SQL.
- Type-oriented query builders for `select`, `insert`, `update`, and
  `delete`.
- SQLite dialect and Bun `bun:sqlite` driver for local execution and
  tests.
- `DataError` taxonomy with query, pool, transaction, migration,
  concurrency, and tenant categories.

## Shipped in PR B

- `createPool` for bounded acquire/release, waiter timeouts, drain, and
  shutdown.
- `forge/data/dialects/postgres` with PostgreSQL SQL compilation and a
  peer-client driver adapter.
- `db.ping()` health hook.
- Optional query tracing and query/pool metrics through injected
  `forge/telemetry` meter/tracer handles.

## Shipped in PR C

- `db.uow()` unit-of-work transactions with commit, rollback, isolation
  levels, retry hooks, and nested savepoints.
- Tenant-scoped handles through `db.withTenant()`, with automatic
  tenant predicates for table builders and raw SQL disabled by default.
- Transaction outbox publishing through `tx.outbox.publish()`.
- `expectUpdated()` optimistic concurrency helper backed by
  `ConcurrencyError`.

## Shipped in PR D

- `migrate()` and `createMigrationSource()` for ordered code migrations,
  state tracking, dry runs, and explicit down migrations.
- `forge/data/schema` helpers for focused migration DDL builders.
- `forge/data/testing` helpers for SQLite test databases, rollback
  fixtures, recording drivers, and driver conformance scenarios.

## Quick Start

```ts
import { createDb } from "forge/data";
import { createSqliteDialect, createSqliteDriver } from "forge/data/dialects/sqlite";

interface AppDb {
  users: {
    id: number;
    email: string;
    status: "active" | "disabled";
    created_at: string;
  };
}

const db = createDb<AppDb>({
  dialect: createSqliteDialect(),
  driver: createSqliteDriver(),
});

const users = await db
  .selectFrom("users")
  .select(["id", "email"] as const)
  .where("status", "=", "active")
  .orderBy("created_at", "desc")
  .limit(10)
  .execute();
```

## Constraints

- No lazy relation loading.
- No entity manager or identity map.
- No code-first table generation.
- PostgreSQL is the production target for later PRs; SQLite is included
  for testing and lightweight embedded use.
