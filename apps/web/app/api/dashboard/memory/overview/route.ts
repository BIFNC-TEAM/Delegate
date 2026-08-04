import {
  getMemoryDashboardOverview,
  memoryOverviewQuerySchema,
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
    const query = parseMemoryDashboardQuery(request, memoryOverviewQuerySchema);
    return memoryDashboardJson(await getMemoryDashboardOverview({
      actorOwnerId,
      representativeSlug: query.rep,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}
