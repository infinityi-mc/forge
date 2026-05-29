import { MigrationError } from "../errors";
import type { Migration, MigrationSource } from "./types";

export function createMigrationSource(
  migrations: readonly Migration[],
): MigrationSource {
  return {
    load() {
      return migrations;
    },
  };
}

export async function loadMigrations(
  source: readonly Migration[] | MigrationSource,
): Promise<readonly Migration[]> {
  const migrations = "load" in source ? await source.load() : source;
  validateMigrations(migrations);
  return [...migrations].sort(compareMigrations);
}

export function compareMigrationVersions(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareMigrations(left: Migration, right: Migration): number {
  return compareMigrationVersions(left.version, right.version);
}

function validateMigrations(migrations: readonly Migration[]): void {
  const versions = new Set<string>();
  const names = new Set<string>();

  for (const migration of migrations) {
    if (migration.version.trim() === "") {
      throw new MigrationError("Migration version is required", {
        migrationName: migration.name,
      });
    }
    if (migration.name.trim() === "") {
      throw new MigrationError("Migration name is required", {
        version: migration.version,
      });
    }
    if (versions.has(migration.version)) {
      throw new MigrationError("Duplicate migration version", {
        version: migration.version,
        migrationName: migration.name,
      });
    }
    if (names.has(migration.name)) {
      throw new MigrationError("Duplicate migration name", {
        version: migration.version,
        migrationName: migration.name,
      });
    }
    versions.add(migration.version);
    names.add(migration.name);
  }
}
