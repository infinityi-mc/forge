export type PostgresSqlState =
  | "40001"
  | "40P01"
  | "53300"
  | "57P01"
  | "57P02"
  | "57P03"
  | string;

export function isRetryablePostgresError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "40001" || code === "40P01";
}

export function isFatalPostgresError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "53300" || code === "57P01" || code === "57P02" || code === "57P03";
}
