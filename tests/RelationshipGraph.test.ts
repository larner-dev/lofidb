import { describe, it, expect, beforeEach } from "vitest";
import {
  RelationshipGraph,
  applyNestedUpdate,
  RelationshipPath,
} from "../src/RelationshipGraph";
import {
  FieldType,
  RelationType,
  LofiDbSchema,
  SubscriptionRecord,
} from "../src/types";

// ──────────────────────────────────────────────
// Test schema (mirrors the FlexLog schema)
// ──────────────────────────────────────────────

const testSchema: LofiDbSchema = {
  items: {
    fields: {
      id: FieldType.ID,
      activityId: FieldType.ID,
      name: FieldType.String,
    },
    relations: [
      {
        type: RelationType.One,
        collection: "activities",
        foreignKey: "activityId",
        field: "activity",
      },
      {
        type: RelationType.Many,
        collection: "values",
        foreignKey: "itemId",
      },
    ],
  },
  activities: {
    fields: {
      id: FieldType.ID,
      name: FieldType.String,
    },
    relations: [
      {
        type: RelationType.Many,
        collection: "properties",
        foreignKey: "activityId",
      },
    ],
  },
  properties: {
    fields: {
      id: FieldType.ID,
      activityId: FieldType.ID,
      name: FieldType.String,
      order: FieldType.Int,
    },
  },
  values: {
    fields: {
      id: FieldType.ID,
      itemId: FieldType.ID,
      propertyId: FieldType.ID,
      value: FieldType.String,
    },
  },
  views: {
    fields: {
      id: FieldType.ID,
      name: FieldType.String,
    },
    relations: [
      {
        type: RelationType.Many,
        collection: "components",
        foreignKey: "viewId",
        order: ["order"],
      },
    ],
  },
  components: {
    fields: {
      id: FieldType.ID,
      viewId: FieldType.ID,
      order: FieldType.Int,
    },
  },
};

// ──────────────────────────────────────────────
// RelationshipGraph
// ──────────────────────────────────────────────

describe("RelationshipGraph", () => {
  let graph: RelationshipGraph;

  beforeEach(() => {
    graph = new RelationshipGraph(testSchema);
  });

  describe("getDirectChildren", () => {
    it("returns direct child collections for items", () => {
      const children = graph.getDirectChildren("items");
      const names = children.map((c) => c.collection);
      expect(names).toContain("activities");
      expect(names).toContain("values");
      expect(names).toHaveLength(2);
    });

    it("returns direct child for activities", () => {
      const children = graph.getDirectChildren("activities");
      expect(children.map((c) => c.collection)).toEqual(["properties"]);
    });

    it("returns empty for leaf collections", () => {
      expect(graph.getDirectChildren("properties")).toEqual([]);
      expect(graph.getDirectChildren("values")).toEqual([]);
    });

    it("returns empty for unknown collections", () => {
      expect(graph.getDirectChildren("nonexistent")).toEqual([]);
    });
  });

  describe("getPathsTo (direct)", () => {
    it("finds direct one-hop path: items → activities", () => {
      const paths = graph.getPathsTo("items", "activities");
      expect(paths).toHaveLength(1);
      expect(paths[0].collections).toEqual(["items", "activities"]);
      expect(paths[0].relations).toHaveLength(1);
      expect(paths[0].relations[0].type).toBe(RelationType.One);
    });

    it("finds direct one-hop path: items → values", () => {
      const paths = graph.getPathsTo("items", "values");
      expect(paths).toHaveLength(1);
      expect(paths[0].collections).toEqual(["items", "values"]);
      expect(paths[0].relations[0].type).toBe(RelationType.Many);
    });

    it("finds direct path: views → components", () => {
      const paths = graph.getPathsTo("views", "components");
      expect(paths).toHaveLength(1);
      expect(paths[0].relations[0].order).toEqual(["order"]);
    });
  });

  describe("getPathsTo (transitive)", () => {
    it("computes items → activities → properties (two hops)", () => {
      const paths = graph.getPathsTo("items", "properties");
      expect(paths).toHaveLength(1);
      expect(paths[0].collections).toEqual([
        "items",
        "activities",
        "properties",
      ]);
      expect(paths[0].relations).toHaveLength(2);
      expect(paths[0].relations[0].collection).toBe("activities");
      expect(paths[0].relations[1].collection).toBe("properties");
    });

    it("returns empty for unrelated collections", () => {
      expect(graph.getPathsTo("properties", "values")).toEqual([]);
      expect(graph.getPathsTo("views", "items")).toEqual([]);
      expect(graph.getPathsTo("components", "activities")).toEqual([]);
    });
  });

  describe("getReachableCollections", () => {
    it("items can reach activities, values, and properties", () => {
      const reachable = graph.getReachableCollections("items");
      expect(reachable).toContain("activities");
      expect(reachable).toContain("values");
      expect(reachable).toContain("properties");
    });

    it("activities can reach properties", () => {
      const reachable = graph.getReachableCollections("activities");
      expect(reachable).toContain("properties");
      expect(reachable).not.toContain("items");
      expect(reachable).not.toContain("values");
    });

    it("leaf collections reach nothing", () => {
      expect(graph.getReachableCollections("properties")).toEqual([]);
    });
  });

  describe("getAffectedParents", () => {
    it("changing properties notifies items and activities", () => {
      const affected = graph.getAffectedParents("properties");
      const parentNames = affected.map((a) => a.parentCollection);
      expect(parentNames).toContain("activities");
      expect(parentNames).toContain("items");
    });

    it("changing values notifies items", () => {
      const affected = graph.getAffectedParents("values");
      const parentNames = affected.map((a) => a.parentCollection);
      expect(parentNames).toContain("items");
      expect(parentNames).not.toContain("activities");
    });

    it("changing components notifies views", () => {
      const affected = graph.getAffectedParents("components");
      const parentNames = affected.map((a) => a.parentCollection);
      expect(parentNames).toContain("views");
    });
  });

  describe("cycle safety", () => {
    it("does not hang on schemas with no relations", () => {
      const simple: LofiDbSchema = {
        things: { fields: { id: FieldType.ID } },
      };
      const g = new RelationshipGraph(simple);
      expect(g.getReachableCollections("things")).toEqual([]);
    });

    it("handles self-referencing schemas (skips self-loops)", () => {
      const selfRef: LofiDbSchema = {
        nodes: {
          fields: { id: FieldType.ID, parentId: FieldType.ID },
          relations: [
            {
              type: RelationType.One,
              collection: "nodes",
              foreignKey: "parentId",
            },
          ],
        },
      };
      // Should not throw or infinite loop
      const g = new RelationshipGraph(selfRef);
      const paths = g.getPathsTo("nodes", "nodes");
      expect(paths).toHaveLength(1); // direct self-reference
    });
  });
});

// ──────────────────────────────────────────────
// applyNestedUpdate
// ──────────────────────────────────────────────

describe("applyNestedUpdate", () => {
  describe("direct Many relation", () => {
    const manyPath: RelationshipPath = {
      collections: ["items", "values"],
      relations: [
        {
          type: RelationType.Many,
          collection: "values",
          foreignKey: "itemId",
        },
      ],
    };

    it("adds a new record to the list", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        values: [{ id: "val-1", itemId: "item-1", value: "a" }],
      };
      const newVal: SubscriptionRecord = {
        id: "val-2",
        itemId: "item-1",
        value: "b",
      };

      const changed = applyNestedUpdate(parent, manyPath, newVal, false);
      expect(changed).toBe(true);
      expect(parent.values as unknown[]).toHaveLength(2);
    });

    it("does not add if foreignKey doesn't match", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        values: [],
      };
      const newVal: SubscriptionRecord = {
        id: "val-1",
        itemId: "item-OTHER",
        value: "x",
      };

      const changed = applyNestedUpdate(parent, manyPath, newVal, false);
      expect(changed).toBe(false);
      expect(parent.values as unknown[]).toHaveLength(0);
    });

    it("updates an existing record in the list", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        values: [{ id: "val-1", itemId: "item-1", value: "old" }],
      };
      const updated: SubscriptionRecord = {
        id: "val-1",
        itemId: "item-1",
        value: "new",
      };

      const changed = applyNestedUpdate(parent, manyPath, updated, false);
      expect(changed).toBe(true);
      expect((parent.values as any[])[0].value).toBe("new");
    });

    it("deletes a record from the list", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        values: [
          { id: "val-1", itemId: "item-1", value: "a" },
          { id: "val-2", itemId: "item-1", value: "b" },
        ],
      };

      const changed = applyNestedUpdate(
        parent,
        manyPath,
        { id: "val-1", itemId: "item-1", value: "a" },
        true,
      );
      expect(changed).toBe(true);
      expect(parent.values as unknown[]).toHaveLength(1);
      expect((parent.values as any[])[0].id).toBe("val-2");
    });

    it("re-sorts after update when relation has order", () => {
      const orderedPath: RelationshipPath = {
        collections: ["views", "components"],
        relations: [
          {
            type: RelationType.Many,
            collection: "components",
            foreignKey: "viewId",
            order: ["order"],
            orderDirection: ["asc"],
          },
        ],
      };

      const parent: SubscriptionRecord = {
        id: "view-1",
        components: [
          { id: "c1", viewId: "view-1", order: 1 },
          { id: "c2", viewId: "view-1", order: 3 },
        ],
      };

      // Insert c3 with order=2 — should end up between c1 and c2
      const newComp: SubscriptionRecord = {
        id: "c3",
        viewId: "view-1",
        order: 2,
      };
      applyNestedUpdate(parent, orderedPath, newComp, false);

      const comps = parent.components as any[];
      expect(comps.map((c: any) => c.id)).toEqual(["c1", "c3", "c2"]);
    });
  });

  describe("direct One relation", () => {
    const onePath: RelationshipPath = {
      collections: ["items", "activities"],
      relations: [
        {
          type: RelationType.One,
          collection: "activities",
          foreignKey: "activityId",
          field: "activity",
        },
      ],
    };

    it("updates a related One record", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: { id: "act-1", name: "Old" },
      };
      const updated: SubscriptionRecord = { id: "act-1", name: "New" };

      const changed = applyNestedUpdate(parent, onePath, updated, false);
      expect(changed).toBe(true);
      expect((parent.activity as any).name).toBe("New");
    });

    it("sets to null on delete", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: { id: "act-1", name: "Running" },
      };

      const changed = applyNestedUpdate(
        parent,
        onePath,
        { id: "act-1", name: "Running" },
        true,
      );
      expect(changed).toBe(true);
      expect(parent.activity).toBe(null);
    });

    it("does not update if foreignKey doesn't match", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: { id: "act-1", name: "Running" },
      };
      const unrelated: SubscriptionRecord = { id: "act-OTHER", name: "X" };

      const changed = applyNestedUpdate(parent, onePath, unrelated, false);
      expect(changed).toBe(false);
      expect((parent.activity as any).name).toBe("Running");
    });
  });

  describe("transitive (multi-hop) updates", () => {
    const transitivePath: RelationshipPath = {
      collections: ["items", "activities", "properties"],
      relations: [
        {
          type: RelationType.One,
          collection: "activities",
          foreignKey: "activityId",
          field: "activity",
        },
        {
          type: RelationType.Many,
          collection: "properties",
          foreignKey: "activityId",
        },
      ],
    };

    it("updates a property nested inside item.activity.properties", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: {
          id: "act-1",
          name: "Activity",
          properties: [
            { id: "p1", activityId: "act-1", name: "Color", order: 1 },
          ],
        },
      };

      const updatedProp: SubscriptionRecord = {
        id: "p1",
        activityId: "act-1",
        name: "Updated Color",
        order: 1,
      };

      const changed = applyNestedUpdate(
        parent,
        transitivePath,
        updatedProp,
        false,
      );
      expect(changed).toBe(true);
      expect(
        ((parent.activity as any).properties[0] as any).name,
      ).toBe("Updated Color");
    });

    it("adds a new property to item.activity.properties", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: {
          id: "act-1",
          name: "Activity",
          properties: [],
        },
      };

      const newProp: SubscriptionRecord = {
        id: "p-new",
        activityId: "act-1",
        name: "Size",
        order: 1,
      };

      const changed = applyNestedUpdate(
        parent,
        transitivePath,
        newProp,
        false,
      );
      expect(changed).toBe(true);
      expect((parent.activity as any).properties).toHaveLength(1);
      expect((parent.activity as any).properties[0].name).toBe("Size");
    });

    it("deletes a property from item.activity.properties", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        activity: {
          id: "act-1",
          name: "Activity",
          properties: [
            { id: "p1", activityId: "act-1", name: "Color", order: 1 },
            { id: "p2", activityId: "act-1", name: "Size", order: 2 },
          ],
        },
      };

      const changed = applyNestedUpdate(
        parent,
        transitivePath,
        { id: "p1", activityId: "act-1", name: "Color", order: 1 },
        true,
      );
      expect(changed).toBe(true);
      expect((parent.activity as any).properties).toHaveLength(1);
      expect((parent.activity as any).properties[0].id).toBe("p2");
    });

    it("returns false when intermediate relation is missing", () => {
      const parent: SubscriptionRecord = {
        id: "item-1",
        activityId: "act-1",
        // activity field is missing (not hydrated)
      };

      const changed = applyNestedUpdate(
        parent,
        transitivePath,
        { id: "p1", activityId: "act-1", name: "X", order: 1 },
        false,
      );
      expect(changed).toBe(false);
    });
  });

  describe("Many → Many transitive path", () => {
    // Imagine: views → components (Many) → subcomponents (Many)
    const schema: LofiDbSchema = {
      views: {
        fields: { id: FieldType.ID },
        relations: [
          {
            type: RelationType.Many,
            collection: "components",
            foreignKey: "viewId",
          },
        ],
      },
      components: {
        fields: { id: FieldType.ID, viewId: FieldType.ID },
        relations: [
          {
            type: RelationType.Many,
            collection: "subcomponents",
            foreignKey: "componentId",
          },
        ],
      },
      subcomponents: {
        fields: { id: FieldType.ID, componentId: FieldType.ID },
      },
    };

    it("updates a subcomponent inside view.components[].subcomponents", () => {
      const graph = new RelationshipGraph(schema);
      const paths = graph.getPathsTo("views", "subcomponents");
      expect(paths).toHaveLength(1);

      const parent: SubscriptionRecord = {
        id: "v1",
        components: [
          {
            id: "c1",
            viewId: "v1",
            subcomponents: [
              { id: "sc1", componentId: "c1", label: "old" },
            ],
          },
          {
            id: "c2",
            viewId: "v1",
            subcomponents: [],
          },
        ],
      };

      const updated: SubscriptionRecord = {
        id: "sc1",
        componentId: "c1",
        label: "new",
      };

      const changed = applyNestedUpdate(parent, paths[0], updated, false);
      expect(changed).toBe(true);
      expect(
        ((parent.components as any[])[0].subcomponents[0] as any).label,
      ).toBe("new");
    });
  });
});
