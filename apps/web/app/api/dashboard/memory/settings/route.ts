import {
  getRepresentativeMemorySettings,
  representativeMemorySettingsQuerySchema,
  representativeMemorySettingsUpdateSchema,
  updateRepresentativeMemorySettings,
} from "@delegate/web-data/memory-settings";

import {
  memorySettingsErrorResponse,
  memorySettingsJson,
  parseMemorySettingsQuery,
  requireMemorySettingsOwnerId,
  requireMemorySettingsWriteMetadata,
} from "../shared";

export async function GET(request: Request) {
  try {
    const actorOwnerId = await requireMemorySettingsOwnerId();
    const query = parseMemorySettingsQuery(
      request,
      representativeMemorySettingsQuerySchema,
    );
    return memorySettingsJson(await getRepresentativeMemorySettings({
      actorOwnerId,
      representativeSlug: query.rep,
    }));
  } catch (error) {
    return memorySettingsErrorResponse(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const actorOwnerId = await requireMemorySettingsOwnerId();
    const query = parseMemorySettingsQuery(
      request,
      representativeMemorySettingsQuerySchema,
    );
    const metadata = requireMemorySettingsWriteMetadata(request);
    const update = representativeMemorySettingsUpdateSchema.parse(
      await request.json().catch(() => null),
    );
    return memorySettingsJson(await updateRepresentativeMemorySettings({
      actorOwnerId,
      representativeSlug: query.rep,
      ...metadata,
      update,
    }));
  } catch (error) {
    return memorySettingsErrorResponse(error);
  }
}
