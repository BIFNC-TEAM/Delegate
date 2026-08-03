import { authorizeDashboardRepresentativeAccess } from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingWriteRetiredResponse } from "../errors";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  return creatorTrainingWriteRetiredResponse();
}
