import {
  executeMemoryDashboardAction,
  listMemoryDashboardOperations,
  memoryOperationActionSchema,
  memoryOperationsQuerySchema,
} from "@delegate/web-data/memory-dashboard";

import {
  memoryDashboardErrorResponse,
  memoryDashboardJson,
  parseMemoryDashboardQuery,
  requireMemoryDashboardOwnerId,
  requireMemoryDashboardWriteMetadata,
} from "../shared";

export async function GET(request: Request) {
  try {
    const actorOwnerId = await requireMemoryDashboardOwnerId();
    const query = parseMemoryDashboardQuery(request, memoryOperationsQuerySchema);
    return memoryDashboardJson(await listMemoryDashboardOperations({
      actorOwnerId,
      representativeSlug: query.rep,
      query,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actorOwnerId = await requireMemoryDashboardOwnerId();
    const query = parseMemoryDashboardQuery(request, memoryOverviewQuerySchemaForAction);
    const metadata = requireMemoryDashboardWriteMetadata(request);
    const action = memoryOperationActionSchema.parse(
      await request.json().catch(() => null),
    );
    return memoryDashboardJson(await executeMemoryDashboardAction({
      actorOwnerId,
      representativeSlug: query.rep,
      ...metadata,
      action,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}

const memoryOverviewQuerySchemaForAction = memoryOperationsQuerySchema.pick({ rep: true });
