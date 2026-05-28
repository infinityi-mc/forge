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
