import orderBy from "lodash.orderby";
import {
  LofiDbSchema,
  Relation,
  RelationType,
  SubscriptionRecord,
} from "./types";

/**
 * A path from one collection to another through relationships.
 * E.g. items → activities → properties would have:
 *   collections: ["items", "activities", "properties"]
 *   relations: [itemsToActivities, activitiesToProperties]
 */
export interface RelationshipPath {
  collections: string[];
  relations: Relation[];
}

/**
 * Computes and stores the full relationship graph between collections.
 *
 * Replaces the ad-hoc transitive closure do/while loop + the
 * `relationships` Record<string, Record<string, Record<string, true>>>
 * from the old LiveDb constructor with a proper data structure.
 *
 * The graph is computed once at construction time and is immutable.
 */
export class RelationshipGraph {
  private paths: Map<string, Map<string, RelationshipPath[]>> = new Map();

  constructor(private schema: LofiDbSchema) {
    this.computePaths();
  }

  /**
   * All paths from parentCollection that reach childCollection
   * (direct or transitive).
   */
  getPathsTo(
    parentCollection: string,
    childCollection: string,
  ): RelationshipPath[] {
    return this.paths.get(parentCollection)?.get(childCollection) || [];
  }

  /** All collections reachable from a starting collection. */
  getReachableCollections(collection: string): string[] {
    return Array.from(this.paths.get(collection)?.keys() || []);
  }

  /** Direct children of a collection (one hop). */
  getDirectChildren(
    collection: string,
  ): { collection: string; relation: Relation }[] {
    const collectionSchema = this.schema[collection];
    if (!collectionSchema?.relations) return [];
    return collectionSchema.relations.map((r) => ({
      collection: r.collection,
      relation: r,
    }));
  }

  /**
   * Given that a record in `changedCollection` was updated/deleted,
   * return all (parentCollection, paths[]) pairs that need notification.
   */
  getAffectedParents(
    changedCollection: string,
  ): { parentCollection: string; paths: RelationshipPath[] }[] {
    const result: { parentCollection: string; paths: RelationshipPath[] }[] =
      [];
    for (const [parentName, childMap] of this.paths) {
      const paths = childMap.get(changedCollection);
      if (paths?.length) {
        result.push({ parentCollection: parentName, paths });
      }
    }
    return result;
  }

  private computePaths() {
    const collectionNames = Object.keys(this.schema);

    // Step 1: seed direct (one-hop) paths
    for (const name of collectionNames) {
      this.paths.set(name, new Map());
      const relations = this.schema[name].relations || [];
      for (const rel of relations) {
        const targetMap = this.paths.get(name)!;
        if (!targetMap.has(rel.collection)) {
          targetMap.set(rel.collection, []);
        }
        targetMap.get(rel.collection)!.push({
          collections: [name, rel.collection],
          relations: [rel],
        });
      }
    }

    // Step 2: BFS-style transitive closure
    let changed = true;
    const maxIterations = collectionNames.length * collectionNames.length;
    let iterations = 0;

    while (changed) {
      changed = false;
      if (++iterations > maxIterations) {
        throw new Error(
          "RelationshipGraph: transitive closure did not converge — possible cycle",
        );
      }

      for (const parent of collectionNames) {
        const parentMap = this.paths.get(parent)!;

        for (const [mid, midPaths] of parentMap) {
          const midMap = this.paths.get(mid);
          if (!midMap) continue;

          for (const [grandchild, grandchildPaths] of midMap) {
            // Skip self-references to avoid infinite loops
            if (grandchild === parent) continue;

            if (!parentMap.has(grandchild)) {
              parentMap.set(grandchild, []);
            }
            const existing = parentMap.get(grandchild)!;

            for (const mp of midPaths) {
              for (const gp of grandchildPaths) {
                const newPath: RelationshipPath = {
                  collections: [
                    ...mp.collections,
                    ...gp.collections.slice(1),
                  ],
                  relations: [...mp.relations, ...gp.relations],
                };
                const sig = newPath.collections.join("/");
                if (!existing.some((p) => p.collections.join("/") === sig)) {
                  existing.push(newPath);
                  changed = true;
                }
              }
            }
          }
        }
      }
    }
  }
}

// ──────────────────────────────────────────────
// Nested update propagation
// ──────────────────────────────────────────────

/**
 * Apply an update to a nested record within a hydrated parent.
 *
 * Walks the relationship path from the parent down to the target level
 * and applies the insert/update/delete at the leaf.
 *
 * Returns true if any mutation occurred.
 *
 * This replaces the old `iterateNestedRelation` stack-based traversal
 * with a cleaner recursive approach.
 */
export function applyNestedUpdate(
  parentRecord: SubscriptionRecord,
  path: RelationshipPath,
  updatedRecord: SubscriptionRecord,
  deleted: boolean,
  stepIndex = 0,
): boolean {
  if (stepIndex >= path.relations.length) return false;

  const relation = path.relations[stepIndex];
  const fieldName = relation.field || relation.collection;
  const isLastStep = stepIndex === path.relations.length - 1;

  if (isLastStep) {
    return applyUpdateToField(
      parentRecord,
      fieldName,
      relation,
      updatedRecord,
      deleted,
    );
  }

  // Not the last step — recurse into nested records
  if (!(fieldName in parentRecord)) return false;

  const nested = parentRecord[fieldName];
  let anyChanged = false;

  if (relation.type === RelationType.Many && Array.isArray(nested)) {
    for (const child of nested) {
      if (child && typeof child === "object" && "id" in child) {
        if (
          applyNestedUpdate(
            child as SubscriptionRecord,
            path,
            updatedRecord,
            deleted,
            stepIndex + 1,
          )
        ) {
          anyChanged = true;
        }
      }
    }
  } else if (
    relation.type === RelationType.One &&
    nested &&
    typeof nested === "object"
  ) {
    if (
      applyNestedUpdate(
        nested as SubscriptionRecord,
        path,
        updatedRecord,
        deleted,
        stepIndex + 1,
      )
    ) {
      anyChanged = true;
    }
  }

  return anyChanged;
}

/**
 * Apply an update/insert/delete to a specific field on a record.
 * Handles both One and Many relation types.
 */
function applyUpdateToField(
  record: SubscriptionRecord,
  fieldName: string,
  relation: Relation,
  updatedRecord: SubscriptionRecord,
  deleted: boolean,
): boolean {
  if (!(fieldName in record)) return false;

  if (relation.type === RelationType.Many) {
    const list = record[fieldName];
    if (!Array.isArray(list)) return false;

    const index = list.findIndex(
      (r: SubscriptionRecord) => r.id === updatedRecord.id,
    );

    if (index >= 0) {
      if (deleted) {
        list.splice(index, 1);
      } else {
        list[index] = updatedRecord;
      }
    } else if (
      !deleted &&
      updatedRecord[relation.foreignKey] === record.id
    ) {
      list.push(updatedRecord);
    } else {
      return false;
    }

    // Re-sort if the relation specifies an order
    if (relation.order?.length) {
      record[fieldName] = orderBy(
        list,
        relation.order,
        relation.orderDirection,
      );
    }

    return true;
  }

  if (relation.type === RelationType.One) {
    if (record[relation.foreignKey] === updatedRecord.id) {
      record[fieldName] = deleted ? null : updatedRecord;
      return true;
    }
  }

  return false;
}
