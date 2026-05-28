import type { ComparisonOperator, QueryKind } from "../types";

export interface PredicateNode {
  readonly column: string;
  readonly operator: ComparisonOperator;
  readonly value: unknown;
}

export interface OrderByNode {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

export interface SelectNode {
  readonly kind: "select";
  readonly table: string;
  readonly columns: readonly string[] | "*";
  readonly where: readonly PredicateNode[];
  readonly orderBy: readonly OrderByNode[];
  readonly limit?: number;
}

export interface InsertNode {
  readonly kind: "insert";
  readonly table: string;
  readonly values: readonly Record<string, unknown>[];
  readonly returning?: readonly string[] | "*";
}

export interface UpdateNode {
  readonly kind: "update";
  readonly table: string;
  readonly set: Record<string, unknown>;
  readonly where: readonly PredicateNode[];
  readonly returning?: readonly string[] | "*";
}

export interface DeleteNode {
  readonly kind: "delete";
  readonly table: string;
  readonly where: readonly PredicateNode[];
  readonly returning?: readonly string[] | "*";
}

export type QueryNode = SelectNode | InsertNode | UpdateNode | DeleteNode;

export function queryKind(node: QueryNode): QueryKind {
  return node.kind;
}
