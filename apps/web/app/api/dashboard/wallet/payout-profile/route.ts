import { z } from "zod";

import {
  getCreatorPayoutProfile,
  submitCreatorPayoutProfile,
} from "@delegate/web-data";

import { requireDashboardBillingAccess } from "../../auth";
import { resolveDashboardRequestMetadata } from "../../request-metadata";
import {
  payoutProfileErrorResponse,
  privatePayoutJson,
} from "./errors";

const submitProfileSchema = z
  .object({
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export async function GET() {
  try {
    const session = await requireDashboardBillingAccess();
    const profile = await getCreatorPayoutProfile({
      ownerId: session.ownerId,
    });
    return privatePayoutJson({
      profile,
      capabilities: {
        tokenizedDestinationSetup: false,
        localMockOperations: process.env.NODE_ENV !== "production",
        productionPayoutExecution: false,
      },
    });
  } catch (error) {
    return payoutProfileErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDashboardBillingAccess();
    const parsed = submitProfileSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return privatePayoutJson(
        {
          error: "A valid payout profile request is required.",
          code: "payout_profile_invalid",
        },
        400,
      );
    }
    const metadata = resolveDashboardRequestMetadata(request);
    const profile = await submitCreatorPayoutProfile({
      ownerId: session.ownerId,
      ...(parsed.data.expectedVersion === undefined
        ? {}
        : { expectedVersion: parsed.data.expectedVersion }),
      idempotencyKey: metadata.idempotencyKey,
    });
    return privatePayoutJson(
      {
        profile,
        requestId: metadata.requestId,
      },
      201,
    );
  } catch (error) {
    return payoutProfileErrorResponse(error);
  }
}
