import type { Dialect } from "../../types";

export function createPostgresDialect(): Dialect {
  return {
    name: "postgresql",
    placeholder(index: number) {
      return `$${index}`;
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier.replaceAll('"', '""')}"`;
    },
  };
}
