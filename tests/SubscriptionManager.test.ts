import { describe, it, expect, beforeEach, vi } from "vitest";
import { SubscriptionManager } from "../src/SubscriptionManager";
import {
  FilterOperation,
  FilterValueType,
  Filters,
  SubscriptionRecord,
} from "../src/types";

const constant = (value: unknown) => ({
  type: FilterValueType.Constant as const,
  value: value as any,
});

interface TestRecord extends SubscriptionRecord {
  name: string;
  age: number;
  active: boolean;
}

describe("SubscriptionManager", () => {
  const alice: TestRecord = { id: "1", name: "Alice", age: 30, active: true };
  const bob: TestRecord = { id: "2", name: "Bob", age: 25, active: false };
  const carol: TestRecord = { id: "3", name: "Carol", age: 35, active: true };
  const allRecords = [alice, bob, carol];

  let queryFn: ReturnType<typeof vi.fn>;
  let manager: SubscriptionManager<TestRecord>;

  beforeEach(() => {
    queryFn = vi.fn().mockResolvedValue(allRecords);
    manager = new SubscriptionManager<TestRecord>(queryFn);
  });

  describe("subscribe", () => {
    it("calls queryFn on first subscription", async () => {
      const fn = vi.fn();
      manager.subscribe(undefined, undefined, undefined, fn);

      // Wait for async refresh
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          loading: false,
          results: allRecords,
        }),
      );
    });

    it("reuses existing subscription for same filters", async () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      const { isNew: isNew1 } = manager.subscribe(
        undefined,
        undefined,
        undefined,
        fn1,
      );
      await vi.waitFor(() => expect(fn1).toHaveBeenCalled());

      const { isNew: isNew2 } = manager.subscribe(
        undefined,
        undefined,
        undefined,
        fn2,
      );

      expect(isNew1).toBe(true);
      expect(isNew2).toBe(false);
      // fn2 should immediately get cached results
      expect(fn2).toHaveBeenCalled();
      // queryFn should only be called once (not re-queried)
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it("does not emit to second subscriber while initial query is in-flight", async () => {
      // Simulate a slow query that we control
      let resolveQuery!: (value: TestRecord[]) => void;
      queryFn.mockReturnValueOnce(
        new Promise<TestRecord[]>((resolve) => {
          resolveQuery = resolve;
        }),
      );

      const fn1 = vi.fn();
      const fn2 = vi.fn();

      // First subscribe triggers refresh (async, not awaited)
      manager.subscribe(undefined, undefined, undefined, fn1);

      // Query is still in-flight — second subscriber attaches to existing subscription
      manager.subscribe(undefined, undefined, undefined, fn2);

      // fn2 should not be called yet — query is still in-flight
      expect(fn2).not.toHaveBeenCalled();

      // Now resolve the query
      resolveQuery(allRecords);

      // Both listeners should get loading: false with results
      await vi.waitFor(() =>
        expect(fn1).toHaveBeenCalledWith(
          expect.objectContaining({
            loading: false,
            results: allRecords,
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(fn2).toHaveBeenCalledWith(
          expect.objectContaining({
            loading: false,
            results: allRecords,
          }),
        ),
      );
    });

    it("creates separate subscriptions for different filters", async () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      const f1: Filters = [
        [["active", FilterOperation.eq, constant(true)]],
      ];
      queryFn.mockResolvedValueOnce([alice, carol]);

      manager.subscribe(f1, undefined, undefined, fn1);
      await vi.waitFor(() => expect(fn1).toHaveBeenCalled());

      queryFn.mockResolvedValueOnce(allRecords);
      manager.subscribe(undefined, undefined, undefined, fn2);
      await vi.waitFor(() => expect(fn2).toHaveBeenCalled());

      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    it("remove() stops receiving updates", async () => {
      const fn = vi.fn();
      const { remove } = manager.subscribe(
        undefined,
        undefined,
        undefined,
        fn,
      );
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      remove();

      // Trigger a change
      manager.handleRecordChange({
        type: "create",
        after: { id: "4", name: "Dave", age: 40, active: true },
      });

      // fn should NOT be called again
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("handleRecordChange (dirty updates)", () => {
    it("adds a new record that matches filters", async () => {
      const fn = vi.fn();
      const f: Filters = [
        [["active", FilterOperation.eq, constant(true)]],
      ];
      queryFn.mockResolvedValueOnce([alice, carol]);
      manager.subscribe(f, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      const dave: TestRecord = {
        id: "4",
        name: "Dave",
        age: 40,
        active: true,
      };
      manager.handleRecordChange({ type: "create", after: dave });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.arrayContaining([
            expect.objectContaining({ id: "4" }),
          ]),
        }),
      );
    });

    it("does not add a record that doesn't match filters", async () => {
      const fn = vi.fn();
      const f: Filters = [
        [["active", FilterOperation.eq, constant(true)]],
      ];
      queryFn.mockResolvedValueOnce([alice]);
      manager.subscribe(f, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      // Bob is not active, shouldn't be added
      manager.handleRecordChange({ type: "create", after: bob });
      expect(fn).not.toHaveBeenCalled();
    });

    it("removes a record when update makes it stop matching", async () => {
      const fn = vi.fn();
      const f: Filters = [
        [["active", FilterOperation.eq, constant(true)]],
      ];
      queryFn.mockResolvedValueOnce([alice, carol]);
      manager.subscribe(f, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      // Alice becomes inactive
      const inactiveAlice: TestRecord = { ...alice, active: false };
      manager.handleRecordChange({
        type: "update",
        before: alice,
        after: inactiveAlice,
      });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.not.arrayContaining([
            expect.objectContaining({ id: "1" }),
          ]),
        }),
      );
    });

    it("removes a record on delete", async () => {
      const fn = vi.fn();
      queryFn.mockResolvedValueOnce(allRecords);
      manager.subscribe(undefined, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      manager.handleRecordChange({ type: "delete", before: bob });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.not.arrayContaining([
            expect.objectContaining({ id: "2" }),
          ]),
        }),
      );
    });

    it("adds a record when update makes it start matching", async () => {
      const fn = vi.fn();
      const f: Filters = [
        [["active", FilterOperation.eq, constant(true)]],
      ];
      queryFn.mockResolvedValueOnce([alice]);
      manager.subscribe(f, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      // Bob becomes active
      const activeBob: TestRecord = { ...bob, active: true };
      manager.handleRecordChange({
        type: "update",
        before: bob,
        after: activeBob,
      });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.arrayContaining([
            expect.objectContaining({ id: "2", active: true }),
          ]),
        }),
      );
    });
  });

  describe("refresh", () => {
    it("re-queries and emits updated results", async () => {
      const fn = vi.fn();
      queryFn.mockResolvedValueOnce([alice]);
      manager.subscribe(undefined, undefined, undefined, fn);
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());

      fn.mockClear();
      queryFn.mockResolvedValueOnce([alice, bob]);

      // Access internal key — in production you'd use refreshAll
      const sub = manager.getSubscription();
      expect(sub).toBeDefined();

      await manager.refreshAll(0);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          results: expect.arrayContaining([
            expect.objectContaining({ id: "1" }),
            expect.objectContaining({ id: "2" }),
          ]),
        }),
      );
    });
  });
});
