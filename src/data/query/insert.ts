import type { InsertNode } from "./ast";
import { compileNode } from "./compile";
import { ExecutableQuery } from "./executor";
import { TenantError } from "../errors";
import type {
  ColumnName,
  Db,
  Dialect,
  Insertable,
  InsertQueryBuilder,
  PickSelected,
  RawQueryBuilder,
  Selectable,
} from "../types";
import type { TenantContext } from "./select";

export class InsertBuilder<Row extends Record<string, unknown>>
  extends ExecutableQuery<Selectable<Row>>
  implements InsertQueryBuilder<Row>
{
  constructor(
    db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
    private readonly dialect: Dialect,
    private readonly node: InsertNode,
    private readonly tenant?: TenantContext,
  ) {
    super(db, () => compileNode(dialect, node));
  }

  values(value: Insertable<Row> | readonly Insertable<Row>[]): InsertQueryBuilder<Row> {
    const rows = (Array.isArray(value) ? value : [value]).map((row) =>
      applyTenantValue(row as Record<string, unknown>, this.tenant),
    );
    return new InsertBuilder<Row>(
      this.db,
      this.dialect,
      {
        ...this.node,
        values: rows as readonly Record<string, unknown>[],
      },
      this.tenant,
    );
  }

  returning<Columns extends readonly ColumnName<Row>[]>(
    columns: Columns,
  ): RawQueryBuilder<PickSelected<Row, Columns>> {
    return new ExecutableQuery<PickSelected<Row, Columns>>(this.db, () =>
      compileNode(this.dialect, { ...this.node, returning: columns }),
    );
  }

  returningAll(): RawQueryBuilder<Selectable<Row>> {
    return new ExecutableQuery<Selectable<Row>>(this.db, () =>
      compileNode(this.dialect, { ...this.node, returning: "*" }),
    );
  }
}

export function createInsertBuilder<Row extends Record<string, unknown>>(
  db: Pick<Db<Record<string, Record<string, unknown>>>, "execute">,
  dialect: Dialect,
  table: string,
  tenant?: TenantContext,
): InsertQueryBuilder<Row> {
  return new InsertBuilder<Row>(
    db,
    dialect,
    {
      kind: "insert",
      table,
      values: [],
    },
    tenant,
  );
}

function applyTenantValue(
  row: Record<string, unknown>,
  tenant: TenantContext | undefined,
): Record<string, unknown> {
  if (tenant === undefined) return row;
  const current = row[tenant.column];
  if (current !== undefined && current !== tenant.id) {
    throw new TenantError("Insert row tenant does not match scoped tenant", {
      tenantId: tenant.id,
    });
  }
  return { ...row, [tenant.column]: tenant.id };
}
