import { z } from "zod";

import {
  activatePayoutDestinationLocally,
  createTokenizedPayoutDestination,
  disablePayoutDestinationLocally,
  reviewCreatorPayoutProfileLocally,
} from "@delegate/web-data";

import { requireDashboardBillingAccess } from "../../../auth";
import { resolveDashboardRequestMetadata } from "../../../request-metadata";
import {
  payoutProfileErrorResponse,
  privatePayoutJson,
} from "../errors";

const commonProfileFields = {
  profileId: z.string().trim().min(1).max(191),
  expectedProfileVersion: z.number().int().min(0),
};

const localPayoutActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_destination"),
      ...commonProfileFields,
      recipientToken: z.string().trim().min(1).max(4_096),
      providerMaskedLabel: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("review"),
      ...commonProfileFields,
      destinationId: z.string().trim().min(1).max(191),
      decision: z.enum(["approve", "reject"]),
      reasonCode: z.string().trim().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("activate"),
      ...commonProfileFields,
      destinationId: z.string().trim().min(1).max(191),
    })
    .strict(),
  z
    .object({
      action: z.literal("disable"),
      ...commonProfileFields,
      destinationId: z.string().trim().min(1).max(191),
    })
    .strict(),
]);

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return privatePayoutJson({ error: "Not found." }, 404);
  }

  try {
    const session = await requireDashboardBillingAccess();
    const parsed = localPayoutActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return privatePayoutJson(
        {
          error: "A valid local payout profile action is required.",
          code: "payout_profile_invalid",
        },
        400,
      );
    }

    const metadata = resolveDashboardRequestMetadata(request);
    const actorId = `local-mock:${session.ownerId}`;
    const action = parsed.data;
    const profile =
      action.action === "create_destination"
        ? await createTokenizedPayoutDestination({
            ownerId: session.ownerId,
            profileId: action.profileId,
            recipientToken: action.recipientToken,
            providerMaskedLabel: action.providerMaskedLabel,
            expectedProfileVersion: action.expectedProfileVersion,
            idempotencyKey: metadata.idempotencyKey,
          })
        : action.action === "review"
          ? await reviewCreatorPayoutProfileLocally({
              ownerId: session.ownerId,
              profileId: action.profileId,
              destinationId: action.destinationId,
              decision: action.decision,
              ...(action.reasonCode
                ? { reasonCode: action.reasonCode }
                : {}),
              actorId,
              expectedProfileVersion: action.expectedProfileVersion,
              idempotencyKey: metadata.idempotencyKey,
            })
          : action.action === "activate"
            ? await activatePayoutDestinationLocally({
                ownerId: session.ownerId,
                profileId: action.profileId,
                destinationId: action.destinationId,
                actorId,
                expectedProfileVersion: action.expectedProfileVersion,
                idempotencyKey: metadata.idempotencyKey,
              })
            : await disablePayoutDestinationLocally({
                ownerId: session.ownerId,
                profileId: action.profileId,
                destinationId: action.destinationId,
                actorId,
                expectedProfileVersion: action.expectedProfileVersion,
                idempotencyKey: metadata.idempotencyKey,
              });

    return privatePayoutJson({
      profile,
      requestId: metadata.requestId,
    });
  } catch (error) {
    return payoutProfileErrorResponse(error);
  }
}
