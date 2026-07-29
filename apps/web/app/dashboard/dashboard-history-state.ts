export const dashboardHistoryPositionKey =
  "__delegateDashboardHistoryPosition";

export type DashboardHistoryMarker = {
  lineage: string;
  position: number;
};

export function readDashboardHistoryMarker(
  state: unknown,
): DashboardHistoryMarker | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const marker = (state as Record<string, unknown>)[
    dashboardHistoryPositionKey
  ];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  const { lineage, position } = marker as Record<string, unknown>;
  return typeof lineage === "string"
    && lineage.length > 0
    && typeof position === "number"
    && Number.isSafeInteger(position)
    ? { lineage, position }
    : null;
}

export function withDashboardHistoryMarker(
  state: unknown,
  marker: DashboardHistoryMarker,
): Record<string, unknown> {
  const source =
    state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : {};
  return {
    ...source,
    [dashboardHistoryPositionKey]: marker,
  };
}

export function nextDashboardHistoryMarker(
  marker: DashboardHistoryMarker,
): DashboardHistoryMarker {
  return {
    lineage: marker.lineage,
    position: marker.position + 1,
  };
}

export function resolveUnsavedHistoryTraversal(input: {
  confirmed: boolean;
  guardedMarker: DashboardHistoryMarker;
  destinationState: unknown;
}):
  | { action: "allow"; destinationPosition: number }
  | { action: "rollback"; delta: number }
  | { action: "bypass" }
  | { action: "stay" } {
  const destinationMarker = readDashboardHistoryMarker(
    input.destinationState,
  );
  if (
    !destinationMarker
    || destinationMarker.lineage !== input.guardedMarker.lineage
  ) {
    return { action: "bypass" };
  }
  const destinationPosition = destinationMarker.position;
  if (input.confirmed) {
    return { action: "allow", destinationPosition };
  }
  const delta = input.guardedMarker.position - destinationPosition;
  return delta === 0 ? { action: "stay" } : { action: "rollback", delta };
}

export function isCurrentDocumentDestination(
  currentHref: string,
  destinationHref: string,
) {
  try {
    const current = new URL(currentHref);
    const destination = new URL(destinationHref);
    if (
      current.origin !== destination.origin
      || current.pathname !== destination.pathname
      || current.hash !== destination.hash
    ) {
      return false;
    }
    const normalizedSearch = (url: URL) =>
      [...url.searchParams.entries()]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
        )
        .map(([key, value]) => `${key}\u0000${value}`);
    const currentSearch = normalizedSearch(current);
    const destinationSearch = normalizedSearch(destination);
    return currentSearch.length === destinationSearch.length
      && currentSearch.every(
        (entry, index) => entry === destinationSearch[index],
      );
  } catch {
    return destinationHref === currentHref;
  }
}

export function isSameDocumentFragmentTraversal(
  currentHref: string,
  destinationHref: string,
) {
  try {
    const current = new URL(currentHref);
    const destination = new URL(destinationHref);
    return current.origin === destination.origin
      && current.pathname === destination.pathname
      && current.search === destination.search
      && current.hash !== destination.hash;
  } catch {
    return false;
  }
}
