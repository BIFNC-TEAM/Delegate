import { archiveOwnerBillingProduct } from "@delegate/web-data";

import {
  requireDashboardRepresentativeBillingAccess,
} from "../../../../../auth";
import {
  resolveDashboardRequestMetadata,
} from "../../../../../request-metadata";
import {
  dashboardBillingProductErrorResponse,
  privateBillingProductJson,
} from "../../errors";

export async function POST(
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
    const product = await archiveOwnerBillingProduct({
      ownerId: session.ownerId,
      representativeSlug: slug,
      productId,
      ...requestMetadata,
      archive: await request.json().catch(() => null),
    });
    return privateBillingProductJson({
      product,
      requestId: requestMetadata.requestId,
    });
  } catch (error) {
    return dashboardBillingProductErrorResponse(error);
  }
}
