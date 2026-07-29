"use client";

import { useLayoutEffect } from "react";

import {
  isSameDocumentFragmentTraversal,
  nextDashboardHistoryMarker,
  readDashboardHistoryMarker,
  withDashboardHistoryMarker,
} from "./dashboard-history-state";

type TrackedWindow = Window & {
  __delegateDashboardHistoryTrackingRuntime?: {
    currentMarker: {
      lineage: string;
      position: number;
    };
    currentHref: string;
    guard:
      | ((
        event: PopStateEvent,
        destinationMarker: {
          lineage: string;
          position: number;
        } | null,
      ) => boolean)
      | null;
  };
};

export function DashboardHistoryTracker() {
  useLayoutEffect(() => installDashboardHistoryTracking(window), []);
  return null;
}

export function installDashboardHistoryTracking(target: TrackedWindow) {
  if (target.__delegateDashboardHistoryTrackingRuntime) return () => {};

  const history = target.history;
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const runtime: NonNullable<
    TrackedWindow["__delegateDashboardHistoryTrackingRuntime"]
  > = {
    currentMarker:
      readDashboardHistoryMarker(history.state) ?? {
        lineage: target.crypto.randomUUID(),
        position: 0,
      },
    currentHref: target.location.href,
    guard: null,
  };

  originalReplaceState(
    withDashboardHistoryMarker(history.state, runtime.currentMarker),
    "",
  );

  const trackedPushState: History["pushState"] = function (
    data,
    unused,
    url,
  ) {
    const nextMarker = nextDashboardHistoryMarker(runtime.currentMarker);
    const result = originalPushState(
      withDashboardHistoryMarker(data, nextMarker),
      unused,
      url,
    );
    runtime.currentMarker = nextMarker;
    runtime.currentHref = target.location.href;
    return result;
  };

  const trackedReplaceState: History["replaceState"] = function (
    data,
    unused,
    url,
  ) {
    const result = originalReplaceState(
      withDashboardHistoryMarker(data, runtime.currentMarker),
      unused,
      url,
    );
    runtime.currentHref = target.location.href;
    return result;
  };
  history.pushState = trackedPushState;
  history.replaceState = trackedReplaceState;

  const handlePopState = (event: PopStateEvent) => {
    let destinationMarker = readDashboardHistoryMarker(event.state);
    if (
      !destinationMarker
      && isSameDocumentFragmentTraversal(
        runtime.currentHref,
        target.location.href,
      )
    ) {
      destinationMarker = nextDashboardHistoryMarker(runtime.currentMarker);
      originalReplaceState(
        withDashboardHistoryMarker(event.state, destinationMarker),
        "",
      );
    }
    if (runtime.guard?.(event, destinationMarker)) return;
    if (destinationMarker?.lineage === runtime.currentMarker.lineage) {
      runtime.currentMarker = destinationMarker;
      runtime.currentHref = target.location.href;
    }
  };
  target.addEventListener("popstate", handlePopState);
  target.__delegateDashboardHistoryTrackingRuntime = runtime;

  return () => {
    if (
      history.pushState !== trackedPushState
      || history.replaceState !== trackedReplaceState
    ) {
      return;
    }
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    target.removeEventListener("popstate", handlePopState);
    if (target.__delegateDashboardHistoryTrackingRuntime === runtime) {
      delete target.__delegateDashboardHistoryTrackingRuntime;
    }
  };
}

export function registerDashboardHistoryGuard(
  target: TrackedWindow,
  guard: (
    event: PopStateEvent,
    destinationMarker: {
      lineage: string;
      position: number;
    } | null,
  ) => boolean,
) {
  const runtime = target.__delegateDashboardHistoryTrackingRuntime;
  if (!runtime) return () => {};
  runtime.guard = guard;
  return () => {
    if (runtime.guard === guard) runtime.guard = null;
  };
}
