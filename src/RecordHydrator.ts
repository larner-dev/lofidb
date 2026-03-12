import snakeCase from "just-snake-case";
import DataLoader from "dataloader";
import {
  DbAdapter,
  FieldType,
  JSValue,
  LofiDbSchema,
  Relation,
  RelationType,
  SubscriptionRecord,
} from "./types";

/**
 * Handles converting between DB rows and hydrated JS records,
 * including loading related records via DataLoader for batching.
 */
export class RecordHydrator<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord = B,
> {
  public loaders: Record<string, DataLoader<string, H[]>> = {};

  constructor(
    private fields: Record<string, FieldType>,
    private relations: Relation[],
    private tableName: string,
    private db: DbAdapter,
    private schema: LofiDbSchema,
  ) {}

  /**
   * Initialize DataLoaders. Must be called after all collections
   * are constructed (since loaders reference sibling hydrators).
   */
  initLoaders(
    getHydrator: (collectionName: string) => RecordHydrator<any, any>,
  ): void {
    for (const rel of this.relations) {
      const foreign = getHydrator(rel.collection);
      this.loaders[rel.collection] = new DataLoader<string, H[]>(
        (ids: readonly string[]) =>
          foreign.fetchBatch(
            rel.type === RelationType.One ? "id" : rel.foreignKey,
            ids,
            rel.order,
            rel.orderDirection,
          ) as Promise<H[][]>,
      );
    }
  }

  clearLoaders(): void {
    for (const key of Object.keys(this.loaders)) {
      this.loaders[key].clearAll();
    }
  }

  /** Convert a single DB row to a base JS record. */
  toJsRecord(dbRecord: Record<string, string | number | null>): B {
    const jsRecord: Record<string, JSValue> = {};
    for (const f of Object.keys(this.fields)) {
      const type = this.fields[f];
      let val = dbRecord[snakeCase(f)] as string | number | undefined;
      if (val === null) val = undefined;

      switch (type) {
        case FieldType.Bool:
          jsRecord[f] = !!val;
          break;
        case FieldType.Date:
          jsRecord[f] = val === undefined ? undefined : new Date(val);
          break;
        case FieldType.JSON:
          jsRecord[f] =
            val === undefined ? undefined : JSON.parse(val.toString());
          break;
        default:
          jsRecord[f] = val;
      }
    }
    return jsRecord as B;
  }

  /** Convert a result set rows to base JS records. */
  rowsToJsRecords(rows: {
    length: number;
    item(i: number): Record<string, string | number | null>;
  }): B[] {
    const results: B[] = [];
    for (let i = 0; i < rows.length; i++) {
      results.push(this.toJsRecord(rows.item(i)));
    }
    return results;
  }

  /** Load a base record and attach all related records. */
  async hydrate(record: B): Promise<H> {
    const hydrated: H = { ...(record as unknown as H) };
    const allRelations = await Promise.all(
      this.relations.map((rel) =>
        this.loaders[rel.collection].load(
          (rel.type === RelationType.One
            ? record[rel.foreignKey]
            : record.id) as string,
        ),
      ),
    );

    for (const [index, rel] of this.relations.entries()) {
      const fieldName = (rel.field || rel.collection) as keyof H;
      const values = allRelations[index] as unknown[];
      hydrated[fieldName] =
        rel.type === RelationType.One
          ? (values[0] as H[keyof H])
          : (values as H[keyof H]);
    }

    return hydrated;
  }

  /** Batch-fetch records by a given field, grouped by ID. */
  async fetchBatch(
    field: string,
    ids: readonly string[],
    order?: string[],
    orderDirection?: ("asc" | "desc")[],
  ): Promise<H[][]> {
    const columnNames = Object.keys(this.fields).map(snakeCase);
    const placeholders = ids.map(() => "?").join(",");
    let sql = `SELECT "${columnNames.join('","')}" FROM "${this.tableName}" WHERE "${snakeCase(field)}" IN (${placeholders})`;

    const validOrderBy = (order || [])
      .filter((f) => f in this.fields)
      .map(snakeCase);
    if (validOrderBy.length) {
      const dir = orderDirection || [];
      sql += ` ORDER BY ${validOrderBy.map((f, i) => `"${f}" ${dir[i] || "asc"}`).join(",")}`;
    }

    const results = await this.db.raw(sql, ids as unknown[]);
    const hydrated = await Promise.all(
      this.rowsToJsRecords(results.rows).map((r) => this.hydrate(r)),
    );

    const grouped: H[][] = Array.from({ length: ids.length }, () => []);
    const idIndex: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) idIndex[ids[i]] = i;

    for (const val of hydrated) {
      const key = val[field] as string;
      if (key in idIndex) {
        grouped[idIndex[key]].push(val);
      }
    }
    return grouped;
  }
}
