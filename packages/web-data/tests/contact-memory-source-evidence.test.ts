import {
  AudienceIdentityStatus,
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  RepresentativeChannelKind,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  lockAndResolveExactMessageIdentityEvidence,
  resolveAndLockIngressIdentityProvenance,
} from "../src/contact-memory-source-evidence";

describe("contact memory exact source evidence", () => {
  it("persists exact Telegram evidence for an anonymous channel identity", async () => {
    const tx = buildTelegramEvidenceClient(AudienceIdentityStatus.ANONYMOUS);

    await expect(resolveAndLockIngressIdentityProvenance(tx as never, {
      sourceChannel: RepresentativeChannelKind.TELEGRAM,
      audienceIdentityId: "audience-anonymous",
      senderId: "123456",
      connectionId: "bot-1",
    })).resolves.toEqual({
      sourceIdentityLinkId: "telegram-link-1",
      sourceIdentityConnectionProofId: "telegram-proof-1",
    });
  });

  it("keeps CONTACT_SHARED fail closed for the same anonymous evidence", async () => {
    const tx = buildTelegramEvidenceClient(AudienceIdentityStatus.ANONYMOUS);

    await expect(lockAndResolveExactMessageIdentityEvidence(tx as never, {
      representativeId: "representative-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      sourceChannel: RepresentativeChannelKind.TELEGRAM,
    })).resolves.toBeNull();
  });
});

function buildTelegramEvidenceClient(status: AudienceIdentityStatus) {
  const link = {
    id: "telegram-link-1",
    audienceIdentityId: "audience-anonymous",
    provider: IdentityLinkProvider.TELEGRAM,
    providerSubject: "123456",
    issuer: "delegate-managed-bot",
    verifiedAt: new Date("2026-08-07T00:00:00.000Z"),
    assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
    revokedAt: null,
  };
  const proof = {
    id: "telegram-proof-1",
    identityLinkId: link.id,
    issuer: link.issuer,
    connectionId: "bot-1",
    verifiedAt: link.verifiedAt,
    assuranceLevel: link.assuranceLevel,
    revokedAt: null,
  };
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    identityLink: {
      findUnique: vi.fn(async (args: {
        where: { id?: string; provider_providerSubject?: unknown };
      }) => args.where.id ? link : { id: link.id }),
    },
    identityLinkConnectionProof: {
      findUnique: vi.fn(async (args: {
        where: { id?: string; identityLinkId_issuer_connectionId?: unknown };
      }) => args.where.id ? proof : { id: proof.id }),
    },
    audienceIdentity: {
      findUnique: vi.fn().mockResolvedValue({
        id: "audience-anonymous",
        status,
        mergedIntoId: null,
      }),
    },
    message: {
      findFirst: vi.fn().mockResolvedValue({
        senderId: "123456",
        sourceIdentityLinkId: link.id,
        sourceIdentityConnectionProofId: proof.id,
        conversation: {
          audienceIdentityId: "audience-anonymous",
          contact: { audienceIdentityId: "audience-anonymous" },
        },
        channelBinding: {
          kind: RepresentativeChannelKind.TELEGRAM,
          connectionId: proof.connectionId,
        },
      }),
    },
  };
}
