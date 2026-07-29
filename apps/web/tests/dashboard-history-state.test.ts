import { describe, expect, it } from "vitest";

import {
  dashboardHistoryPositionKey,
  isCurrentDocumentDestination,
  isSameDocumentFragmentTraversal,
  nextDashboardHistoryMarker,
  readDashboardHistoryMarker,
  resolveUnsavedHistoryTraversal,
  withDashboardHistoryMarker,
} from "../app/dashboard/dashboard-history-state";
import {
  installDashboardHistoryTracking,
  registerDashboardHistoryGuard,
} from "../app/dashboard/dashboard-history-tracker";

const marker = { lineage: "lineage-1", position: 4 };

describe("Dashboard history state", () => {
  it("preserves Next.js history state while adding a traversal position", () => {
    const state = withDashboardHistoryMarker(
      {
        __NA: true,
        __PRIVATE_NEXTJS_INTERNALS_TREE: { renderedSearch: "view=settings" },
      },
      marker,
    );

    expect(state).toMatchObject({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: { renderedSearch: "view=settings" },
      [dashboardHistoryPositionKey]: marker,
    });
    expect(readDashboardHistoryMarker(state)).toEqual(marker);
    expect(nextDashboardHistoryMarker(marker)).toEqual({
      lineage: "lineage-1",
      position: 5,
    });
  });

  it("rolls cancelled single- and multi-step Back and Forward traversals to the guarded entry", () => {
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: marker.lineage,
          position: 3,
        }),
      }),
    ).toEqual({ action: "rollback", delta: 1 });
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: marker.lineage,
          position: 1,
        }),
      }),
    ).toEqual({ action: "rollback", delta: 3 });
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: marker.lineage,
          position: 5,
        }),
      }),
    ).toEqual({ action: "rollback", delta: -1 });
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: marker.lineage,
          position: 8,
        }),
      }),
    ).toEqual({ action: "rollback", delta: -4 });
  });

  it("allows confirmed traversal and bypasses unmarked or unrelated entries", () => {
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: true,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: marker.lineage,
          position: 3,
        }),
      }),
    ).toEqual({ action: "allow", destinationPosition: 3 });
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: null,
      }),
    ).toEqual({ action: "bypass" });
    expect(
      resolveUnsavedHistoryTraversal({
        confirmed: false,
        guardedMarker: marker,
        destinationState: withDashboardHistoryMarker({}, {
          lineage: "another-lineage",
          position: 3,
        }),
      }),
    ).toEqual({ action: "bypass" });
  });

  it("tracks push, replace, popstate, and duplicate installation without losing Next state", () => {
    const listeners: Array<(event: PopStateEvent) => void> = [];
    const history = {
      state: {
        __NA: true,
        __PRIVATE_NEXTJS_INTERNALS_TREE: { renderedSearch: "" },
      } as unknown,
      pushState(data: unknown) {
        this.state = data;
      },
      replaceState(data: unknown) {
        this.state = data;
      },
    };
    const target = {
      crypto: { randomUUID: () => "lineage-test" },
      history,
      location: { href: "https://delegate.test/dashboard" },
      addEventListener(type: string, listener: (event: PopStateEvent) => void) {
        if (type === "popstate") listeners.push(listener);
      },
      removeEventListener() {},
    } as unknown as Window;

    installDashboardHistoryTracking(target);
    const initialMarker = readDashboardHistoryMarker(history.state);
    expect(initialMarker).toEqual({ lineage: "lineage-test", position: 0 });

    target.history.pushState({ __NA: true }, "");
    expect(readDashboardHistoryMarker(history.state)?.position).toBe(1);
    target.history.replaceState(
      {
        __NA: true,
        __PRIVATE_NEXTJS_INTERNALS_TREE: { renderedSearch: "view=settings" },
      },
      "",
    );
    expect(readDashboardHistoryMarker(history.state)?.position).toBe(1);
    expect(history.state).toMatchObject({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: {
        renderedSearch: "view=settings",
      },
    });

    listeners[0]?.({
      state: withDashboardHistoryMarker({}, {
        lineage: "lineage-test",
        position: 0,
      }),
    } as PopStateEvent);
    target.history.pushState({ __NA: true }, "");
    expect(readDashboardHistoryMarker(history.state)?.position).toBe(1);

    installDashboardHistoryTracking(target);
    expect(listeners).toHaveLength(1);
  });

  it("dispatches an active guard before updating the tracked traversal position", () => {
    const listeners: Array<(event: PopStateEvent) => void> = [];
    const history = {
      state: withDashboardHistoryMarker(
        { __NA: true },
        { lineage: "lineage-test", position: 1 },
      ) as unknown,
      pushState(data: unknown) {
        this.state = data;
      },
      replaceState(data: unknown) {
        this.state = data;
      },
    };
    const target = {
      crypto: { randomUUID: () => "unused" },
      history,
      location: { href: "https://delegate.test/dashboard" },
      addEventListener(type: string, listener: (event: PopStateEvent) => void) {
        if (type === "popstate") listeners.push(listener);
      },
      removeEventListener() {},
    } as unknown as Window;
    installDashboardHistoryTracking(target);
    const seen: number[] = [];
    const unregister = registerDashboardHistoryGuard(target, (event) => {
      seen.push(
        readDashboardHistoryMarker(event.state)?.position ?? -1,
      );
      return true;
    });

    listeners[0]?.({
      state: withDashboardHistoryMarker(
        { __NA: true },
        { lineage: "lineage-test", position: 0 },
      ),
    } as PopStateEvent);
    target.history.pushState({ __NA: true }, "");
    expect(seen).toEqual([0]);
    expect(readDashboardHistoryMarker(history.state)?.position).toBe(2);

    unregister();
    listeners[0]?.({
      state: withDashboardHistoryMarker(
        { __NA: true },
        { lineage: "lineage-test", position: 0 },
      ),
    } as PopStateEvent);
    target.history.pushState({ __NA: true }, "");
    expect(readDashboardHistoryMarker(history.state)?.position).toBe(1);
  });

  it("marks native fragment entries before dispatching the guard", () => {
    const listeners: Array<(event: PopStateEvent) => void> = [];
    const history = {
      state: withDashboardHistoryMarker(
        { __NA: true },
        { lineage: "lineage-test", position: 0 },
      ) as unknown,
      pushState(data: unknown) {
        this.state = data;
      },
      replaceState(data: unknown) {
        this.state = data;
      },
    };
    const target = {
      crypto: { randomUUID: () => "unused" },
      history,
      location: {
        href: "https://delegate.test/dashboard?view=settings#profile",
      },
      addEventListener(type: string, listener: (event: PopStateEvent) => void) {
        if (type === "popstate") listeners.push(listener);
      },
      removeEventListener() {},
    } as unknown as Window;
    installDashboardHistoryTracking(target);
    const seen: Array<{ lineage: string; position: number } | null> = [];
    registerDashboardHistoryGuard(target, (_event, destinationMarker) => {
      seen.push(destinationMarker);
      return false;
    });

    (target.location as Location).href =
      "https://delegate.test/dashboard?view=settings#security";
    listeners[0]?.({ state: null } as PopStateEvent);

    expect(seen).toEqual([{ lineage: "lineage-test", position: 1 }]);
    expect(readDashboardHistoryMarker(history.state)).toEqual({
      lineage: "lineage-test",
      position: 1,
    });
  });

  it("does not guard a link that resolves to the current document URL", () => {
    expect(
      isCurrentDocumentDestination(
        "https://delegate.test/dashboard?view=settings",
        "https://delegate.test/dashboard?view=settings",
      ),
    ).toBe(true);
    expect(
      isCurrentDocumentDestination(
        "https://delegate.test/dashboard?rep=lin&view=settings&lang=zh",
        "https://delegate.test/dashboard?lang=zh&view=settings&rep=lin",
      ),
    ).toBe(true);
    expect(
      isCurrentDocumentDestination(
        "https://delegate.test/dashboard?view=settings",
        "https://delegate.test/dashboard?view=overview",
      ),
    ).toBe(false);
    expect(
      isSameDocumentFragmentTraversal(
        "https://delegate.test/dashboard?view=settings#profile",
        "https://delegate.test/dashboard?view=settings#security",
      ),
    ).toBe(true);
    expect(
      isSameDocumentFragmentTraversal(
        "https://delegate.test/dashboard?view=settings#profile",
        "https://delegate.test/dashboard?view=overview#security",
      ),
    ).toBe(false);
  });
});
