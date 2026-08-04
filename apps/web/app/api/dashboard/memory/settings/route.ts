import {
  getMemoryDashboardSettings,
  memorySettingsQuerySchema,
  memorySettingsUpdateSchema,
  updateMemoryDashboardSettings,
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
    const query = parseMemoryDashboardQuery(request, memorySettingsQuerySchema);
    return memoryDashboardJson(await getMemoryDashboardSettings({
      actorOwnerId,
      representativeSlug: query.rep,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const actorOwnerId = await requireMemoryDashboardOwnerId();
    const query = parseMemoryDashboardQuery(request, memorySettingsQuerySchema);
    const metadata = requireMemoryDashboardWriteMetadata(request);
    const update = memorySettingsUpdateSchema.parse(
      await request.json().catch(() => null),
    );
    return memoryDashboardJson(await updateMemoryDashboardSettings({
      actorOwnerId,
      representativeSlug: query.rep,
      ...metadata,
      update,
    }));
  } catch (error) {
    return memoryDashboardErrorResponse(error);
  }
}
