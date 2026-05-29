import { MigrationError, QueryError } from "../errors";
import { raw, sql } from "../sql";
import type { Db } from "../types";
import { loadMigrations } from "./source";
import type { MigrateOptions, MigrateResult, Migration, MigrationDirection, MigrationState } from "./types";

const STATE_TABLE = "_forge_migrations";

export async function migrate(db: Db<any>, options: MigrateOptions): Promise<MigrateResult> {
  const direction = options.direction ?? "up";
  const migrations = await loadMigrations(options.migrations);
  const states = await readStates(db, options.dryRun !== true);

  if (direction === "up") {
    const pending = pendingUp(migrations, states, options.to);
    if (options.dryRun === true) {
      return { direction, applied: [], pending: pending.map(toState) };
    }
    const applied = await runUp(db, pending);
    return { direction, applied, pending: [] };
  }

  const pending = pendingDown(migrations, states, options.to);
  if (options.dryRun === true) {
    return { direction, applied: [], pending: pending.map(toState) };
  }
  const applied = await runDown(db, pending);
  return { direction, applied, pending: [] };
}

async function ensureStateTable(db: Db<any>): Promise<void> {
  await db.raw(sql`
    create table if not exists ${raw(STATE_TABLE)} (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    )
  `).execute();
}

async function readStates(db: Db<any>, ensure: boolean): Promise<Map<string, MigrationState>> {
  if (ensure) await ensureStateTable(db);
  const rows = await db.raw<{
      version: string;
      name: string;
      checksum: string;
      applied_at: string;
    }>(sql`
      select version, name, checksum, applied_at
      from ${raw(STATE_TABLE)}
      order by version asc
    `).execute()
    .catch((cause) => {
      if (!ensure && cause instanceof QueryError) {
        return { rows: [], numAffectedRows: 0n };
      }
      throw cause;
    });

  return new Map(rows.rows.map((row) => [row.version, {
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }]));
}

function pendingUp(
  migrations: readonly Migration[],
  states: Map<string, MigrationState>,
  to: string | undefined,
): readonly Migration[] {
  return migrations.filter((migration) => {
    if (states.has(migration.version)) return false;
    return to === undefined || migration.version <= to;
  });
}

function pendingDown(
  migrations: readonly Migration[],
  states: Map<string, MigrationState>,
  to: string | undefined,
): readonly Migration[] {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  return [...states.values()]
    .filter((state) => to === undefined || state.version > to)
    .sort((left, right) => right.version.localeCompare(left.version))
    .map((state) => {
      const migration = byVersion.get(state.version);
      if (migration === undefined) {
        throw new MigrationError("Cannot roll back unknown migration", {
          version: state.version,
          migrationName: state.name,
        });
      }
      if (migration.down === undefined) {
        throw new MigrationError("Migration does not define a down function", {
          version: migration.version,
          migrationName: migration.name,
        });
      }
      return migration;
    });
}

async function runUp(db: Db<any>, migrations: readonly Migration[]): Promise<readonly MigrationState[]> {
  const applied: MigrationState[] = [];
  await db.uow(async (tx) => {
    for (const migration of migrations) {
      await migration.up(tx);
      const state = toState(migration);
      await insertState(tx, state);
      applied.push(state);
    }
  });
  return applied;
}

async function runDown(db: Db<any>, migrations: readonly Migration[]): Promise<readonly MigrationState[]> {
  const applied: MigrationState[] = [];
  await db.uow(async (tx) => {
    for (const migration of migrations) {
      await migration.down?.(tx);
      const state = toState(migration);
      await deleteState(tx, migration.version);
      applied.push(state);
    }
  });
  return applied;
}

async function insertState(db: Db<any>, state: MigrationState): Promise<void> {
  await db.raw(sql`
    insert into ${raw(STATE_TABLE)} (version, name, checksum, applied_at)
    values (${state.version}, ${state.name}, ${state.checksum}, ${state.appliedAt})
  `).execute();
}

async function deleteState(db: Db<any>, version: string): Promise<void> {
  await db.raw(sql`
    delete from ${raw(STATE_TABLE)}
    where version = ${version}
  `).execute();
}

function toState(migration: Migration): MigrationState {
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum ?? checksumFor(migration),
    appliedAt: new Date().toISOString(),
  };
}

function checksumFor(migration: Migration): string {
  return hash(`${migration.version}:${migration.name}`);
}

function hash(value: string): string {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = ((result << 5) + result) ^ value.charCodeAt(index);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
