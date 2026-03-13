import EventEmitter from "eventemitter3";
import snakeCase from "just-snake-case";
import { produce } from "immer";
import { FilterEngine } from "./FilterEngine";
import { RecordHydrator } from "./RecordHydrator";
import {
  SubscriptionManager,
  SubscriptionMatchCheck,
} from "./SubscriptionManager";
import { RelationshipGraph, applyNestedUpdate } from "./RelationshipGraph";
import {
  DbAdapter,
  ErrorHandler,
  Filters,
  FieldType,
  JSValue,
  LofiDbSchema,
  OrderDirection,
  Relation,
  ScalarJSValue,
  SubscriptionRecord,
  UpdateRecord,
} from "./types";

interface CollectionEvents<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord,
> {
  create: (ctx: {
    id: string;
    input: B;
    after: H;
    emitContext?: Record<string, unknown>;
  }) => void;
  update: (ctx: {
    id: string;
    input: UpdateRecord<B>;
    before: H;
    after: H;
    emitContext?: Record<string, unknown>;
  }) => void;
  delete: (ctx: {
    id: string;
    before: H;
    emitContext?: Record<string, unknown>;
  }) => void;
}

export class Collection<
  B extends SubscriptionRecord,
  H extends SubscriptionRecord = B,
> extends EventEmitter<CollectionEvents<B, H>> {
  public name = "";
  public tableName = "";
  public relations: Relation[] = [];
  public fields: Record<string, FieldType> = {};

  public hydrator!: RecordHydrator<B, H>;
  public subscriptions!: SubscriptionManager<H>;
  private filterEngine: FilterEngine;
  private onError: ErrorHandler;

  private graph?: RelationshipGraph;
  private schema: LofiDbSchema = {};
  private updateListeners: ((
    collection: string,
    record: SubscriptionRecord,
    deleted?: boolean,
  ) => void)[] = [];

  constructor(
    private db: DbAdapter,
    filterEngine?: FilterEngine,
    onError?: ErrorHandler,
  ) {
    super();
    this.filterEngine = filterEngine || new FilterEngine();
    this.onError =
      onError ||
      ((e) => console.error(`[lofidb] ${e.type}: ${e.title} — ${e.message}`));
  }

  /**
   * Called by LofiDb after all collections are constructed.
   * Wires up the hydrator, subscription manager, and relationship graph.
   */
  init(schema: LofiDbSchema, graph: RelationshipGraph): void {
    this.schema = schema;
    this.graph = graph;

    this.hydrator = new RecordHydrator<B, H>(
      this.fields as Record<string, FieldType>,
      this.relations,
      this.tableName,
      this.db,
      schema,
    );

    this.subscriptions = new SubscriptionManager<H>(
      (filters, order, orderDirection) =>
        this.filter({ filters, order, orderDirection }),
      this.filterEngine,
    );
  }

  onUpdate(
    listener: (
      collection: string,
      record: SubscriptionRecord,
      deleted?: boolean,
    ) => void,
  ): void {
    this.updateListeners.push(listener);
  }

  /**
   * Handle a change notification from a child collection.
   * Uses the RelationshipGraph to find which subscription results
   * need patching, then applies updates via applyNestedUpdate.
   */
  onUpdateRelated(
    childCollection: string,
    updatedRecord: SubscriptionRecord,
    deleted?: boolean,
  ): void {
    if (!this.graph) return;

    const paths = this.graph.getPathsTo(this.name, childCollection);
    if (!paths.length) return;

    for (const path of paths) {
      this.patchSubscriptionResults(path, updatedRecord, deleted || false);
    }
  }

  private patchSubscriptionResults(
    path: any,
    updatedRecord: SubscriptionRecord,
    deleted: boolean,
  ): void {
    const subManager = this.subscriptions as any;
    const subs = subManager.subscriptions || {};

    for (const key of Object.keys(subs)) {
      const sub = subs[key];
      const newResults = produce(sub.results, (draft: any) => {
        const records = Object.keys(draft).map((k) => draft[k].record);
        for (const record of records) {
          applyNestedUpdate(record, path, updatedRecord, deleted);
        }
      });

      if (newResults !== sub.results) {
        sub.results = newResults;
        sub.notifyListeners();
      }
    }
  }

  // ──────────────────────────────────────────────
  // Query methods
  // ──────────────────────────────────────────────

  async filter({
    filters,
    order,
    orderDirection,
  }: {
    filters?: Filters;
    order?: string[];
    orderDirection?: OrderDirection;
  }): Promise<H[]> {
    this.hydrator.clearLoaders();
    const base = await this.rawQuery(filters, order, orderDirection);
    return Promise.all(base.map((r) => this.hydrator.hydrate(r)));
  }

  async fetch(id: string): Promise<H | null> {
    const columnNames = Object.keys(this.fields).map(snakeCase);
    const result = await this.db.raw(
      `SELECT "${columnNames.join('","')}" FROM "${this.tableName}" WHERE "id"=? LIMIT 1`,
      [id],
    );
    if (!result.rows.length) {
      return null;
    }
    const record = this.hydrator.toJsRecord(result.rows.item(0));
    return this.hydrator.hydrate(record);
  }

  async fetchOrThrow(id: string): Promise<H> {
    const result = await this.fetch(id);
    if (!result) {
      throw new Error(`${this.name} with id="${id}" not found`);
    }
    return result;
  }

  private async rawQuery(
    filters?: Filters,
    order?: string[],
    orderDirection?: OrderDirection,
  ): Promise<B[]> {
    const columnNames = Object.keys(this.fields).map(snakeCase);
    let sql = `SELECT "${columnNames.join('","')}" FROM "${this.tableName}"`;
    let inputValues: ScalarJSValue[] = [];

    if (filters?.length) {
      const { sql: whereSql, values } = this.filterEngine.toSql(filters);
      if (whereSql) {
        sql += ` WHERE ${whereSql}`;
        inputValues = values;
      }
    }

    const fieldNames = Object.keys(this.fields);
    const validOrderBy = (order || [])
      .filter((f) => fieldNames.includes(f))
      .map(snakeCase);
    if (validOrderBy.length) {
      const dir = orderDirection || [];
      sql += ` ORDER BY ${validOrderBy.map((f, i) => `"${f}" ${dir[i] || "asc"}`).join(",")}`;
    }

    const sqlValues = inputValues.map((v) => this.filterEngine.toSqlValue(v));
    const result = await this.db.raw(sql, sqlValues);
    return this.hydrator.rowsToJsRecords(result.rows);
  }

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  async create(
    record: B,
    emitContext?: Record<string, unknown>,
  ): Promise<void> {
    this.hydrator.clearLoaders();
    const fieldNames = Object.keys(this.fields).filter((f) => f in record);
    const columnNames = fieldNames.map(snakeCase);

    await this.db.raw(
      `INSERT INTO "${this.tableName}" ("${columnNames.join('","')}") VALUES(${columnNames.map(() => "?").join(",")})`,
      fieldNames.map((f) => this.filterEngine.toSqlValue(record[f] as JSValue)),
    );

    const after = await this.hydrator.hydrate(record);

    this.handleUpdate({ type: "create", after });
    this.emit("create", { id: after.id, after, input: record, emitContext });
  }

  async update(
    id: string,
    record: UpdateRecord<B>,
    emitContext?: Record<string, unknown>,
  ): Promise<boolean> {
    this.hydrator.clearLoaders();
    const fieldNames = Object.keys(this.fields).filter((f) => f in record);
    const columnNames = fieldNames.map(snakeCase);
    if (!columnNames.length) return false;

    let before: H;
    try {
      before = await this.fetchOrThrow(id);
    } catch {
      return false;
    }

    const result = await this.db.raw(
      `UPDATE "${this.tableName}" SET ${columnNames.map((c) => `"${c}" = ?`).join(",")} WHERE "id"=?`,
      [
        ...fieldNames.map((f) =>
          this.filterEngine.toSqlValue(record[f] as JSValue),
        ),
        id,
      ],
    );
    if (!result.rowsAffected) return false;

    let after: H;
    try {
      after = await this.fetchOrThrow(id);
    } catch {
      this.onError({
        type: "error",
        title: "Fetch Error",
        message: "Record disappeared after update",
      });
      return false;
    }

    this.handleUpdate({ type: "update", before, after });
    this.emit("update", { id, before, after, input: record, emitContext });
    return true;
  }

  async upsert(
    record: B,
    emitContext?: Record<string, unknown>,
  ): Promise<boolean> {
    this.hydrator.clearLoaders();
    const { id, ...update } = record;
    const updated = await this.update(id, update, emitContext);
    if (!updated) {
      await this.create(record, emitContext);
    }
    return true;
  }

  async delete(
    id: string,
    emitContext?: Record<string, unknown>,
  ): Promise<boolean> {
    this.hydrator.clearLoaders();
    let before: H;
    try {
      before = await this.fetchOrThrow(id);
    } catch {
      return false;
    }

    await this.db.raw(`DELETE FROM "${this.tableName}" WHERE "id"=?`, [id]);

    this.handleUpdate({ type: "delete", before });
    this.emit("delete", { id, before, emitContext });
    return true;
  }

  // ──────────────────────────────────────────────
  // Internal: propagate changes
  // ──────────────────────────────────────────────

  private handleUpdate(check: SubscriptionMatchCheck<H>): void {
    this.subscriptions.handleRecordChange(check);

    const record = check.type === "delete" ? check.before : check.after;
    const deleted = check.type === "delete";
    for (const listener of this.updateListeners) {
      listener(this.name, record, deleted);
    }
  }

  async refreshAll(): Promise<void> {
    await this.subscriptions.refreshAll();
  }
}
