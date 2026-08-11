import {
  createAndPublishOwnerBillingProduct,
  getOwnerRepresentativeBillingCatalog,
  updateOwnerRepresentativeCommerceSettings,
} from "@delegate/web-data";

import {
  requireDashboardRepresentativeBillingAccess,
} from "../../../auth";
import { resolveDashboardRequestMetadata } from "../../../request-metadata";
import {
  dashboardBillingProductErrorResponse,
  privateBillingProductJson,
} from "./errors";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(slug);
    const catalog = await getOwnerRepresentativeBillingCatalog({
      ownerId: session.ownerId,
      representativeSlug: slug,
    });
    return privateBillingProductJson(catalog);
  } catch (error) {
    return dashboardBillingProductErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(slug);
    const requestMetadata = resolveDashboardRequestMetadata(request);
    const product = await createAndPublishOwnerBillingProduct({
      ownerId: session.ownerId,
      representativeSlug: slug,
      ...requestMetadata,
      product: await request.json().catch(() => null),
    });
    return privateBillingProductJson(
      { product, requestId: requestMetadata.requestId },
      201,
    );
  } catch (error) {
    return dashboardBillingProductErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(slug);
    const requestMetadata = resolveDashboardRequestMetadata(request);
    const representative =
      await updateOwnerRepresentativeCommerceSettings({
        ownerId: session.ownerId,
        representativeSlug: slug,
        ...requestMetadata,
        settings: await request.json().catch(() => null),
      });
    return privateBillingProductJson({
      representative,
      requestId: requestMetadata.requestId,
    });
  } catch (error) {
    return dashboardBillingProductErrorResponse(error);
  }
}
