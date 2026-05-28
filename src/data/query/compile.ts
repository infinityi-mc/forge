import type { SqlFragment } from "../sql";
import type { CompiledQuery, Dialect } from "../types";
import type { DeleteNode, InsertNode, PredicateNode, QueryNode, SelectNode, UpdateNode } from "./ast";

export function compileNode(dialect: Dialect, node: QueryNode): CompiledQuery {
  switch (node.kind) {
    case "select":
      return compileSelect(dialect, node);
    case "insert":
      return compileInsert(dialect, node);
    case "update":
      return compileUpdate(dialect, node);
    case "delete":
      return compileDelete(dialect, node);
  }
}

export function compileRaw(query: SqlFragment): CompiledQuery {
  return { sql: query.text, params: query.params, kind: "raw" };
}

function compileSelect(dialect: Dialect, node: SelectNode): CompiledQuery {
  const params: unknown[] = [];
  const columns = compileColumns(dialect, node.columns);
  const parts = [`select ${columns} from ${dialect.quoteIdentifier(node.table)}`];
  appendWhere(dialect, parts, params, node.where);

  if (node.orderBy.length > 0) {
    const orderBy = node.orderBy
      .map((item) => `${dialect.quoteIdentifier(item.column)} ${item.direction}`)
      .join(", ");
    parts.push(`order by ${orderBy}`);
  }

  if (node.limit !== undefined) {
    params.push(node.limit);
    parts.push(`limit ${dialect.placeholder(params.length)}`);
  }

  return { sql: parts.join(" "), params, kind: "select" };
}

function compileInsert(dialect: Dialect, node: InsertNode): CompiledQuery {
  if (node.values.length === 0) {
    throw new Error("insert requires at least one value row");
  }

  const params: unknown[] = [];
  const columns = Object.keys(node.values[0] ?? {});
  if (columns.length === 0) {
    throw new Error("insert value row must contain at least one column");
  }

  const columnSql = columns.map((column) => dialect.quoteIdentifier(column)).join(", ");
  const valuesSql = node.values
    .map((row) => {
      const placeholders = columns.map((column) => {
        params.push(row[column]);
        return dialect.placeholder(params.length);
      });
      return `(${placeholders.join(", ")})`;
    })
    .join(", ");

  const parts = [
    `insert into ${dialect.quoteIdentifier(node.table)} (${columnSql}) values ${valuesSql}`,
  ];
  appendReturning(dialect, parts, node.returning);
  return { sql: parts.join(" "), params, kind: "insert" };
}

function compileUpdate(dialect: Dialect, node: UpdateNode): CompiledQuery {
  const params: unknown[] = [];
  const columns = Object.keys(node.set);
  if (columns.length === 0) {
    throw new Error("update requires at least one set value");
  }

  const assignments = columns.map((column) => {
    params.push(node.set[column]);
    return `${dialect.quoteIdentifier(column)} = ${dialect.placeholder(params.length)}`;
  });
  const parts = [
    `update ${dialect.quoteIdentifier(node.table)} set ${assignments.join(", ")}`,
  ];
  appendWhere(dialect, parts, params, node.where);
  appendReturning(dialect, parts, node.returning);
  return { sql: parts.join(" "), params, kind: "update" };
}

function compileDelete(dialect: Dialect, node: DeleteNode): CompiledQuery {
  const params: unknown[] = [];
  const parts = [`delete from ${dialect.quoteIdentifier(node.table)}`];
  appendWhere(dialect, parts, params, node.where);
  appendReturning(dialect, parts, node.returning);
  return { sql: parts.join(" "), params, kind: "delete" };
}

function appendWhere(
  dialect: Dialect,
  parts: string[],
  params: unknown[],
  predicates: readonly PredicateNode[],
): void {
  if (predicates.length === 0) return;
  const sql = predicates.map((predicate) => {
    params.push(predicate.value);
    return `${dialect.quoteIdentifier(predicate.column)} ${predicate.operator} ${dialect.placeholder(params.length)}`;
  });
  parts.push(`where ${sql.join(" and ")}`);
}

function appendReturning(
  dialect: Dialect,
  parts: string[],
  returning: readonly string[] | "*" | undefined,
): void {
  if (returning === undefined) return;
  parts.push(`returning ${compileColumns(dialect, returning)}`);
}

function compileColumns(dialect: Dialect, columns: readonly string[] | "*"): string {
  if (columns === "*") return "*";
  if (columns.length === 0) return "*";
  return columns.map((column) => dialect.quoteIdentifier(column)).join(", ");
}
