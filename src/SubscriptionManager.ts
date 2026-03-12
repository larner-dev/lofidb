import objectHash from "object-hash";
import sortBy from "lodash.sortby";
import { produce } from "immer";
import { FilterEngine } from "./FilterEngine";
import { Subscription } from "./Subscription";
import {
  Filters,
  OrderDirection,
  SubscriptionRecord,
} from "./types";

/**
 * Manages subscriptions for a single collection.
 *
 * Responsibilities:
 * - Creating/removing subscriptions (deduped by filter+order hash)
 * - The refresh loop (one implementation, not duplicated)
 * - Optimistic "dirty" updates when a record changes
 *
 * The `queryFn` callback is how the manager asks the Collection
 * to run the actual DB query — keeping SQL concerns out of here.
 */
export class SubscriptionManager<
  H extends SubscriptionRecord = SubscriptionRecord,
> {
  private subscriptions: Record<string, Subscription<H>> = {};
  private filterEngine: FilterEngine;

  constructor(
    private queryFn: (
      filters?: Filters,
      order?: string[],
      orderDirection?: OrderDirection,
    ) => Promise<H[]>,
    filterEngine?: FilterEngine,
  ) {
    this.filterEngine = filterEngine || new FilterEngine();
  }

  subscribe(
    filters: Filters | undefined,
    order: string[] | undefined,
    orderDirection: OrderDirection | undefined,
    fn: (arg: { loading: boolean; error: string; results: H[] }) => void,
  ): { remove: () => void; isNew: boolean } {
    const key = this.toKey(filters, order, orderDirection);
    let isNew = false;

    if (!(key in this.subscriptions)) {
      isNew = true;
      this.subscriptions[key] = new Subscription<H>(
        filters,
        order,
        orderDirection,
        this.filterEngine,
      );
    }

    const sub = this.subscriptions[key];
    sub.on("change", fn);

    if (isNew) {
      this.refresh(key);
    } else {
      sub.emit("change", {
        loading: false,
        error: "",
        results: sub.getResultList<H>(),
      });
    }

    return {
      isNew,
      remove: () => {
        sub.off("change", fn);
      },
    };
  }

  getSubscription(
    filters?: Filters,
    order?: string[],
    orderDirection?: OrderDirection,
  ): Subscription<H> | undefined {
    const key = this.toKey(filters, order, orderDirection);
    return this.subscriptions[key];
  }

  async refresh(key: string): Promise<void> {
    const sub = this.subscriptions[key];
    if (!sub) return;

    if (sub.loading) {
      sub.dirty = true;
      return;
    }

    sub.loading = true;
    try {
      do {
        sub.dirty = false;
        const list = await this.queryFn(
          sub.filters,
          sub.order,
          sub.orderDirection,
        );
        sub.applyQueryResults(list as SubscriptionRecord[]);
        sub.notifyListeners();
      } while (sub.dirty);
    } finally {
      sub.loading = false;
    }
  }

  async refreshAll(delayMs = 500): Promise<void> {
    for (const key of Object.keys(this.subscriptions)) {
      await this.refresh(key);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  handleRecordChange(check: SubscriptionMatchCheck<H>): void {
    for (const key of Object.keys(this.subscriptions)) {
      const sub = this.subscriptions[key];
      this.applyDirtyUpdate(sub, check);
    }
  }

  private applyDirtyUpdate(
    sub: Subscription<H>,
    check: SubscriptionMatchCheck<H>,
  ): void {
    const action = this.getUpdateAction(sub, check);
    if (action === DirtyUpdateAction.None) return;

    // Pre-compute outside produce to avoid union narrowing issues
    let targetId: string | undefined;
    let targetRecord: SubscriptionRecord | undefined;

    if (action === DirtyUpdateAction.Delete) {
      targetId =
        check.type === "delete" || check.type === "update"
          ? check.before.id
          : undefined;
    } else if (action === DirtyUpdateAction.Upsert) {
      targetRecord =
        check.type === "create" || check.type === "update"
          ? check.after
          : undefined;
    }

    const oldResults = sub.results;
    sub.results = produce(sub.results, (draft) => {
      if (action === DirtyUpdateAction.Delete && targetId) {
        delete draft[targetId];
      } else if (action === DirtyUpdateAction.Upsert && targetRecord) {
        draft[targetRecord.id] = {
          order: Object.keys(draft).length,
          record: targetRecord,
        };
      }
    });

    if (oldResults !== sub.results) {
      sub.notifyListeners();
    }
  }

  private getUpdateAction(
    sub: Subscription<H>,
    check: SubscriptionMatchCheck<H>,
  ): DirtyUpdateAction {
    if (check.type === "delete") {
      return sub.matches(check.before)
        ? DirtyUpdateAction.Delete
        : DirtyUpdateAction.None;
    }

    if (check.type === "create") {
      return sub.matches(check.after)
        ? DirtyUpdateAction.Upsert
        : DirtyUpdateAction.None;
    }

    const matchedBefore = sub.matches(check.before);
    const matchesAfter = sub.matches(check.after);

    if (matchedBefore && !matchesAfter) return DirtyUpdateAction.Delete;
    if (matchesAfter) return DirtyUpdateAction.Upsert;
    return DirtyUpdateAction.None;
  }

  private toKey(
    filters?: Filters,
    order?: string[],
    orderDirection?: OrderDirection,
  ): string {
    return objectHash({
      filters: sortBy(filters, (or: unknown) =>
        objectHash(sortBy(or as unknown[], objectHash)),
      ),
      order,
      orderDirection,
    });
  }
}

enum DirtyUpdateAction {
  None = "none",
  Upsert = "upsert",
  Delete = "delete",
}

interface SubscriptionMatchCreateCheck<T extends SubscriptionRecord> {
  type: "create";
  after: T;
}

interface SubscriptionMatchDeleteCheck<T extends SubscriptionRecord> {
  type: "delete";
  before: T;
}

interface SubscriptionMatchUpdateCheck<T extends SubscriptionRecord> {
  type: "update";
  before: T;
  after: T;
}

export type SubscriptionMatchCheck<T extends SubscriptionRecord> =
  | SubscriptionMatchCreateCheck<T>
  | SubscriptionMatchDeleteCheck<T>
  | SubscriptionMatchUpdateCheck<T>;
