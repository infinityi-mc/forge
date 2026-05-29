import { createDb } from "../db";
import { createSqliteDialect, createSqliteDriver } from "../dialects/sqlite";
import type { DatabaseSchema, Db } from "../types";

export function createSqliteTestDb<Schema extends DatabaseSchema>(): Db<Schema> {
  return createDb<Schema>({
    dialect: createSqliteDialect(),
    driver: createSqliteDriver(),
  });
}
