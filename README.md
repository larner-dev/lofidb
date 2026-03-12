# LofiDb

A reactive local-first database layer for JavaScript/TypeScript apps. LofiDb wraps any SQLite driver with subscription-based reactivity, automatic relationship hydration, and optimistic UI updates.

**What it does:** You define a schema, connect a SQLite adapter, and LofiDb gives you reactive collections that push updates to your UI whenever data changes — no polling, no manual invalidation.

## Install

```bash
npm install lofidb
```

## Quick Start

```typescript
import { LofiDb, Collection, FieldType, RelationType } from "lofidb";

// 1. Define your schema
const schema = {
  todos: {
    fields: {
      id: FieldType.ID,
      title: FieldType.String,
      completed: FieldType.Bool,
      categoryId: FieldType.ID,
      createdAt: FieldType.Date,
    },
    relations: [
      {
        type: RelationType.One,
        collection: "categories",
        foreignKey: "categoryId",
        field: "category",
      },
    ],
  },
  categories: {
    fields: {
      id: FieldType.ID,
      name: FieldType.String,
      color: FieldType.String,
    },
  },
};

// 2. Create a typed subclass
interface BaseTodo { id: string; title: string; completed: boolean; categoryId: string; createdAt: Date; }
interface HydratedTodo extends BaseTodo { category: BaseCategory; }
interface BaseCategory { id: string; name: string; color: string; }

class MyDb extends LofiDb {
  todos!: Collection<BaseTodo, HydratedTodo>;
  categories!: Collection<BaseCategory>;
}

// 3. Connect your SQLite adapter
const db = new MyDb(schema, sqliteAdapter);
```

## Database Adapter

LofiDb works with any SQLite driver. Implement the `DbAdapter` interface:

```typescript
import { DbAdapter, DbResultSet } from "lofidb";

const adapter: DbAdapter = {
  async raw(sql: string, params: unknown[]): Promise<DbResultSet> {
    // Run the query and return results in WebSQL format
    // Return: { rows: { length, item(i) }, rowsAffected }
  },
};
```

### React Native (react-native-sqlite-2)

```typescript
import SQLite from "react-native-sqlite-2";

const sqliteDb = SQLite.openDatabase("myapp.db", "1.0", "", 4 * 1024 * 1024);

const adapter: DbAdapter = {
  raw: (sql, params) =>
    new Promise((resolve, reject) => {
      sqliteDb.transaction(
        (tx) => {
          tx.executeSql(sql, params, (_tx, results) => resolve(results));
        },
        (error) => reject(error),
      );
    }),
};
```

### Expo SQLite

```typescript
import * as SQLite from "expo-sqlite";

const sqliteDb = SQLite.openDatabaseSync("myapp.db");

const adapter: DbAdapter = {
  raw: async (sql, params) => {
    const result = await sqliteDb.execAsync([{ sql, args: params }], false);
    return {
      rows: {
        length: result[0].rows.length,
        item: (i: number) => result[0].rows[i],
      },
      rowsAffected: result[0].rowsAffected,
    };
  },
};
```

### better-sqlite3 (Node.js)

```typescript
import Database from "better-sqlite3";

const sqliteDb = new Database("myapp.db");

const adapter: DbAdapter = {
  raw: async (sql, params) => {
    if (sql.trim().toUpperCase().startsWith("SELECT")) {
      const rows = sqliteDb.prepare(sql).all(...params);
      return {
        rows: {
          length: rows.length,
          item: (i: number) => rows[i],
        },
        rowsAffected: 0,
      };
    }
    const result = sqliteDb.prepare(sql).run(...params);
    return {
      rows: { length: 0, item: () => ({}) },
      rowsAffected: result.changes,
    };
  },
};
```

## Subscriptions & React Hook

```tsx
import { useLofiQuery } from "lofidb/react";
import { FilterOperation, FilterValueType } from "lofidb";

function TodoList() {
  const { results, loading } = useLofiQuery({
    collection: db.todos,
    filters: [
      [
        ["completed", FilterOperation.eq, { type: FilterValueType.Constant, value: false }],
      ],
    ],
    order: ["createdAt"],
    orderDirection: ["desc"],
  });

  if (loading) return <Text>Loading...</Text>;
  return results.map((todo) => <TodoItem key={todo.id} todo={todo} />);
}
```

The hook automatically re-renders when:
- A record is created/updated/deleted that matches the filters
- A related record changes (nested update propagation)
- The app returns to the foreground (if configured)

### Vanilla JS Subscriptions

```typescript
const { remove } = db.todos.subscriptions.subscribe(
  filters,
  ["createdAt"],
  ["desc"],
  ({ results, loading, error }) => {
    console.log("Todos changed:", results);
  },
);

// Later: stop listening
remove();
```

## Filters

Filters use AND/OR logic. The outer array is OR groups, inner arrays are AND clauses:

```typescript
// completed = true AND createdAt > startOfToday
const filters = [
  [
    ["completed", FilterOperation.eq, { type: FilterValueType.Constant, value: true }],
    ["createdAt", FilterOperation.gt, { type: FilterValueType.Dynamic, value: DynamicFilterValue.StartOfToday }],
  ],
];

// name = "Alice" OR name = "Bob"  (two OR groups, one clause each)
const filters2 = [
  [["name", FilterOperation.eq, { type: FilterValueType.Constant, value: "Alice" }]],
  [["name", FilterOperation.eq, { type: FilterValueType.Constant, value: "Bob" }]],
];
```

### Dynamic values

| Value | Resolves to |
|-------|------------|
| `DynamicFilterValue.StartOfToday` | Midnight today (ISO string). Subscriptions auto-refresh at midnight. |
| `DynamicFilterValue.EndOfToday` | 23:59:59.999 today. |
| `DynamicFilterValue.Empty` | `null` — generates `IS NULL` in SQL. |

### Nested field filters

Filters support dot notation for hydrated relations:

```typescript
// Filter items where activity.name = "Running"
const filters = [
  [["activity.name", FilterOperation.eq, { type: FilterValueType.Constant, value: "Running" }]],
];
```

## CRUD

```typescript
// Create
await db.todos.create({
  id: "todo-1",
  title: "Buy milk",
  completed: false,
  categoryId: "cat-1",
  createdAt: new Date(),
});

// Update
await db.todos.update("todo-1", { completed: true });

// Upsert (update if exists, create if not)
await db.todos.upsert({ id: "todo-1", title: "Buy oat milk", ... });

// Delete
await db.todos.delete("todo-1");

// Fetch one
const todo = await db.todos.fetchOrThrow("todo-1");
```

All CRUD operations automatically notify active subscriptions.

## Lifecycle Hooks

```typescript
const db = new MyDb(schema, adapter, {
  // React Native: refresh on foreground
  onAppForeground: (callback) => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") callback();
    });
    return () => sub.remove();
  },

  // Web: refresh on visibility change
  // onAppForeground: (callback) => {
  //   const handler = () => {
  //     if (document.visibilityState === "visible") callback();
  //   };
  //   document.addEventListener("visibilitychange", handler);
  //   return () => document.removeEventListener("visibilitychange", handler);
  // },

  // Custom error handler (default: console.error)
  onError: ({ type, title, message }) => {
    Toast.show({ type, text1: title, text2: message });
  },
});
```

## Events

Listen to changes at the database level:

```typescript
db.on("create", ({ collection, id, after }) => {
  console.log(`Created ${collection} ${id}`);
});

db.on("update", ({ collection, id, before, after }) => {
  console.log(`Updated ${collection} ${id}`);
});

db.on("delete", ({ collection, id, before }) => {
  console.log(`Deleted ${collection} ${id}`);
});
```

Or at the collection level:

```typescript
db.todos.on("create", ({ id, after, input }) => {
  // Sync to server, etc.
});
```

## Architecture

```
src/
  types.ts              — All shared types (DbAdapter, filters, schema, records)
  FilterEngine.ts       — Filter matching (memory) + SQL generation (single source of truth)
  RelationshipGraph.ts  — Computes relationship paths, handles nested update propagation
  Subscription.ts       — Lightweight data holder for a single subscription's state
  SubscriptionManager.ts — Subscription lifecycle, refresh loop, dirty updates
  RecordHydrator.ts     — DB row → JS record conversion, DataLoader batching, hydration
  Collection.ts         — Thin CRUD orchestrator delegating to the above
  LofiDb.ts             — Schema registration, collection wiring, app lifecycle
  react.ts              — useLofiQuery hook (separate entry point, react is optional peer dep)
```

### Why this structure

**FilterEngine is the single source of truth for filter semantics.** Both in-memory `matches()` and SQL `toSql()` share the same `resolveValue()` (dynamic value unpacking) and `normalizeForComparison()` (type coercion). This eliminates the most common bug class: SQL/memory filter drift.

**RelationshipGraph replaces ad-hoc transitive closure computation** with a proper graph that has named methods (`getPathsTo`, `getAffectedParents`) and cycle detection.

**SubscriptionManager has one refresh loop**, not two duplicate implementations.

**No platform dependencies in the core.** React, React Native AppState, and Toast are all optional/injectable.

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

111 tests across 3 suites covering FilterEngine (71), RelationshipGraph (30), and SubscriptionManager (10).
