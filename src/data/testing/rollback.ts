import { sql } from "../sql";
import type { DatabaseSchema, Db } from "../types";

export async function withRollbackTest<Schema extends DatabaseSchema, Result>(
  db: Db<Schema>,
  fn: (tx: Db<Schema>) => Promise<Result> | Result,
): Promise<Result> {
  let result: Result | undefined;
  await db.uow(async (tx) => {
    result = await fn(tx);
    throw new RollbackSentinel();
  }).catch((cause) => {
    if (!(cause instanceof RollbackSentinel)) throw cause;
  });
  return result as Result;
}

export async function truncateAll(db: Db<any>, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    await db.raw(sql`delete from ${sqlIdentifier(table)}`).execute();
  }
}

function sqlIdentifier(identifier: string) {
  return { text: `"${identifier.replaceAll('"', '""')}"`, params: [] };
}

class RollbackSentinel extends Error {
  constructor() {
    super("rollback test complete");
    this.name = "RollbackSentinel";
  }
}
