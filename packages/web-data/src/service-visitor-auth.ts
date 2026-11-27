import type { Prisma } from "@prisma/client";

import { ServiceRequestError } from "./service-request-contract";

/** Host adapters supply the trusted identity; a contact alone grants no access. */
export async function requireRegisteredServiceVisitor(
  tx: Prisma.TransactionClient,
  audienceIdentityId: string | null,
) {
  const identity = audienceIdentityId
    ? await tx.audienceIdentity.findFirst({
        where: {
          id: audienceIdentityId,
          status: "REGISTERED",
          mergedIntoId: null,
          account: {
            status: "ACTIVE",
            authIdentities: { some: { status: "ACTIVE" } },
          },
        },
        select: { id: true },
      })
    : null;
  if (!identity) throw new ServiceRequestError("authentication_required", 401);
}
