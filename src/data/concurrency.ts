import { ConcurrencyError } from "./errors";

export interface OptimisticResult {
  readonly numUpdatedRows?: bigint;
  readonly numDeletedRows?: bigint;
}

export function expectUpdated<Result extends OptimisticResult>(
  result: Result,
  message = "Optimistic concurrency check failed",
): Result {
  const affected = result.numUpdatedRows ?? result.numDeletedRows ?? 0n;
  if (affected === 0n) {
    throw new ConcurrencyError(message);
  }
  return result;
}
