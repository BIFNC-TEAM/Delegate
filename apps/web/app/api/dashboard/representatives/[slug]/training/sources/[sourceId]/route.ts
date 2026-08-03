import { authorizeDashboardRepresentativeAccess } from "../../../../../auth";
import { withPrivateNoStore } from "../../../../../../private-response";
import { creatorTrainingWriteRetiredResponse } from "../../errors";

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  return creatorTrainingWriteRetiredResponse();
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  return creatorTrainingWriteRetiredResponse();
}
