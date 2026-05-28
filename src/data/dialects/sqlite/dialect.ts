import type { Dialect } from "../../types";

export function createSqliteDialect(): Dialect {
  return {
    name: "sqlite",
    placeholder() {
      return "?";
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier.replaceAll('"', '""')}"`;
    },
  };
}
