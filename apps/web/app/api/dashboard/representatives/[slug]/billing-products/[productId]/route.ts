import { updateOwnerBillingProduct } from "@delegate/web-data";

import {
  requireDashboardRepresentativeBillingAccess,
} from "../../../../auth";
import {
  resolveDashboardRequestMetadata,
} from "../../../../request-metadata";
import {
  dashboardBillingProductErrorResponse,
  privateBillingProductJson,
} from "../errors";

export async function PATCH(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string; productId: string }>;
  },
) {
  const { slug, productId } = await params;
  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(slug);
    const requestMetadata = resolveDashboardRequestMetadata(request);
    const product = await updateOwnerBillingProduct({
      ownerId: session.ownerId,
      representativeSlug: slug,
      productId,
      ...requestMetadata,
      product: await request.json().catch(() => null),
    });
    return privateBillingProductJson({
      product,
      requestId: requestMetadata.requestId,
    });
  } catch (error) {
    return dashboardBillingProductErrorResponse(error);
  }
}
