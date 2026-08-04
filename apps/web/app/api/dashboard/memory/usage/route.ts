import {
  listMemoryDashboardUsage,
  memoryUsageQuerySchema,
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
    const query = parseMemoryDashboardQuery(request, memoryUsageQuerySchema);
    return memoryDashboardJson(await listMemoryDashboardUsage({
      actorOwnerId,
      representativeSlug: query.rep,
      query,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}
