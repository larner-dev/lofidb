import EventEmitter from "eventemitter3";
import snakeCase from "just-snake-case";
import { Collection } from "./Collection";
import { FilterEngine } from "./FilterEngine";
import { RelationshipGraph } from "./RelationshipGraph";
import {
  DbAdapter,
  LofiDbSchema,
  LofiDbOptions,
  SubscriptionRecord,
} from "./types";

export const SCHEMA_KEY = Symbol("schema");

type LofiDbEvents = {
  create: (ctx: { collection: string } & Record<string, unknown>) => void;
  update: (ctx: { collection: string } & Record<string, unknown>) => void;
  delete: (ctx: { collection: string } & Record<string, unknown>) => void;
};

/**
 * LofiDb wires together collections, their relationships, and
 * change propagation.
 *
 * Usage:
 * ```ts
 * import { LofiDb, FieldType, RelationType } from "lofidb";
 *
 * class MyDb extends LofiDb {
 *   users!: Collection<BaseUser, HydratedUser>;
 *   posts!: Collection<BasePost, HydratedPost>;
 * }
 *
 * const db = new MyDb(schema, dbAdapter, {
 *   onAppForeground: (cb) => {
 *     const sub = AppState.addEventListener("change", (s) => {
 *       if (s === "active") cb();
 *     });
 *     return () => sub.remove();
 *   },
 * });
 * ```
 */
export class LofiDb extends EventEmitter<LofiDbEvents> {
  protected [SCHEMA_KEY]: LofiDbSchema;
  private graph: RelationshipGraph;
  private filterEngine: FilterEngine;
  private cleanupForeground?: () => void;

  constructor(
    schema: LofiDbSchema,
    db: DbAdapter,
    options: LofiDbOptions = {},
  ) {
    super();
    this[SCHEMA_KEY] = schema;
    this.filterEngine = new FilterEngine();
    this.graph = new RelationshipGraph(schema);

    const collectionNames = Object.keys(schema);

    // Step 1: Create all collections
    for (const name of collectionNames as (keyof this)[]) {
      const collection = new Collection(
        db,
        this.filterEngine,
        options.onError,
      ) as this[keyof this];
      this[name] = collection;
      const col = collection as unknown as Collection<SubscriptionRecord>;
      col.name = name as string;
      col.tableName = snakeCase(col.name);
      const colSchema = schema[col.name];
      col.relations = colSchema.relations || [];
      col.fields = colSchema.fields;
    }

    // Step 2: Initialize each collection (hydrators, subscription managers)
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      col.init(schema, this.graph);
    }

    // Step 3: Wire up hydrator loaders (cross-collection references)
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      col.hydrator.initLoaders((collName) => {
        const target = this[collName as keyof this] as unknown as Collection<SubscriptionRecord>;
        return target.hydrator;
      });
    }

    // Step 4: Wire up nested update propagation
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      const reachable = this.graph.getReachableCollections(name);
      for (const childName of reachable) {
        const child = this[childName as keyof this] as unknown as Collection<SubscriptionRecord>;
        child.onUpdate(col.onUpdateRelated.bind(col));
      }
    }

    // Step 5: Forward events to LofiDb level
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      col.on("create", (ctx) =>
        this.emit("create", { collection: name, ...ctx }),
      );
      col.on("update", (ctx) =>
        this.emit("update", { collection: name, ...ctx }),
      );
      col.on("delete", (ctx) =>
        this.emit("delete", { collection: name, ...ctx }),
      );
    }

    // Step 6: Optional foreground refresh hook
    if (options.onAppForeground) {
      const cleanup = options.onAppForeground(() => this.refreshAll());
      if (cleanup) {
        this.cleanupForeground = cleanup;
      }
    }
  }

  async refreshAll(): Promise<void> {
    const collectionNames = Object.keys(this[SCHEMA_KEY]);
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      await col.refreshAll();
    }
  }

  /** Invalidate all DataLoader caches across all collections. */
  invalidateAllLoaders(): void {
    const collectionNames = Object.keys(this[SCHEMA_KEY]);
    for (const name of collectionNames) {
      const col = this[name as keyof this] as unknown as Collection<SubscriptionRecord>;
      col.hydrator.clearLoaders();
    }
  }

  /** Clean up timers and event listeners. */
  destroy(): void {
    if (this.cleanupForeground) {
      this.cleanupForeground();
    }
    this.removeAllListeners();
  }
}
