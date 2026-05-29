import type { Db } from "../types";

export interface Migration {
  readonly version: string;
  readonly name: string;
  up(db: Db<any>): Promise<void> | void;
  down?(db: Db<any>): Promise<void> | void;
  readonly checksum?: string;
}

export interface MigrationSource {
  load(): Promise<readonly Migration[]> | readonly Migration[];
}

export interface MigrationState {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export type MigrationDirection = "up" | "down";

export interface MigrateOptions {
  readonly migrations: readonly Migration[] | MigrationSource;
  readonly direction?: MigrationDirection;
  readonly to?: string;
  readonly dryRun?: boolean;
  readonly lock?: boolean;
}

export interface MigrateResult {
  readonly direction: MigrationDirection;
  readonly applied: readonly MigrationState[];
  readonly pending: readonly MigrationState[];
}
