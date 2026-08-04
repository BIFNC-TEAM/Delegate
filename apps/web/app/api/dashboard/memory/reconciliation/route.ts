import {
  listMemoryDashboardReconciliation,
  memoryReconciliationQuerySchema,
} from "@delegate/web-data/memory-dashboard";

import {
  memoryDashboardErrorResponse,
  memoryDashboardJson,
  parseMemoryDashboardQuery,
  requireMemoryDashboardOwnerId,
} from "../shared";

export async function GET(request: Request) {
  try {
    const actorOwnerId = await requireMemoryDashboardOwnerId();
    const query = parseMemoryDashboardQuery(request, memoryReconciliationQuerySchema);
    return memoryDashboardJson(await listMemoryDashboardReconciliation({
      actorOwnerId,
      representativeSlug: query.rep,
      query,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}
