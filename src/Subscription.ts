import EventEmitter from "eventemitter3";
import { produce } from "immer";
import orderBy from "lodash.orderby";
import { FilterEngine } from "./FilterEngine";
import {
  Filters,
  OrderDirection,
  SubscriptionRecord,
} from "./types";

export type ResultsMap = Record<
  string,
  { order: number; record: SubscriptionRecord }
>;

interface SubscriptionChangeEvent<T> {
  loading: boolean;
  error: string;
  results: T[];
}

type SubscriptionEvents<T> = {
  change: (event: SubscriptionChangeEvent<T>) => void;
  needsRefresh: () => void;
};

/**
 * A Subscription tracks a set of filter+order criteria and maintains
 * a cached result set. It delegates all filter matching to FilterEngine.
 *
 * Lifecycle:
 * 1. Created by SubscriptionManager when a component subscribes.
 * 2. Results populated by `applyQueryResults` after a DB query.
 * 3. Optimistic updates applied via dirty update in SubscriptionManager.
 * 4. Listeners notified via EventEmitter on any change.
 */
export class Subscription<
  T extends SubscriptionRecord = SubscriptionRecord,
> extends EventEmitter<SubscriptionEvents<T>> {
  public results: ResultsMap = {};
  public dirty = true;
  public loading = false;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly filters: Filters | undefined,
    public readonly order: string[] | undefined,
    public readonly orderDirection: OrderDirection | undefined,
    private filterEngine: FilterEngine,
  ) {
    super();

    // Set up daily refresh for StartOfToday/EndOfToday filters
    if (filterEngine.hasDailyDynamicValues(filters)) {
      this.scheduleDailyRefresh();
    }
  }

  /** Check if a hydrated record matches this subscription's filters. */
  matches(record: SubscriptionRecord): boolean {
    return this.filterEngine.matches(
      record as Record<string, unknown>,
      this.filters,
    );
  }

  /**
   * Replace the full result set from a DB query.
   * Uses immer for structural sharing.
   */
  applyQueryResults(list: SubscriptionRecord[]): void {
    this.results = produce(this.results, (draft) => {
      const ids: Record<string, boolean> = {};
      for (let i = 0; i < list.length; i++) {
        const record = list[i];
        ids[record.id] = true;
        if (!(record.id in draft)) {
          draft[record.id] = { order: i, record };
        } else {
          draft[record.id].order = i;
          for (const k in record) {
            draft[record.id].record[k] = record[k];
          }
        }
      }
      for (const id of Object.keys(draft)) {
        if (!(id in ids)) {
          delete draft[id];
        }
      }
    });
  }

  /** Get sorted results as an array. */
  getResultList<R = T>(): R[] {
    return orderBy(
      Object.keys(this.results).map((k) => this.results[k].record) as R[],
      this.order,
      this.orderDirection,
    );
  }

  /** Emit the current state to all listeners. */
  notifyListeners(): void {
    this.emit("change", {
      loading: false,
      error: "",
      results: this.getResultList<T>(),
    });
  }

  destroy(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
    this.removeAllListeners();
  }

  /** Schedule a refresh at the next midnight, then reschedule daily. */
  private scheduleDailyRefresh(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    this.dailyTimer = setTimeout(() => {
      this.emit("needsRefresh");
      this.scheduleDailyRefresh();
    }, msUntilMidnight);
  }
}
