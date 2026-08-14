import {
  AudienceIdentityStatus,
  ContactMemorySharingConsentStatus,
  ContactMemorySharingSourceEventRole,
  IdentityAssuranceLevel,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  contactMemorySharingConsentContractVersion,
  createContactMemorySharingChallenge,
  getContactMemorySharingState,
  grantContactMemorySharingConsent,
  readContactMemorySharingChallengeToken,
  resolveDeterministicContactMemorySharingCommand,
  revokeContactMemorySharingConsent,
} from "../src";

const challengeToken = "A".repeat(43);
const webEvidence = {
  sourceChannel: "WEB" as const,
  providerSubject: "logto-subject-1",
  issuer: "https://issuer.example",
  connectionId: "signed-web-session-1",
  sourceIdentityLinkId: "link-1",
};

describe("contact memory sharing consent", () => {
  it("treats the user's latest revocation as authoritative across policy revisions", async () => {
    const consentFindFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: ContactMemorySharingConsentStatus.REVOKED,
        revokedAt: new Date("2026-08-08T00:00:00.000Z"),
      });
    const client = {
      representative: {
        findUnique: vi.fn(async () => ({ id: "rep-1", slug: "delegate" })),
      },
      representativeMemoryPolicy: {
        findUnique: vi.fn(async () => ({
          revision: 9,
          longTermMemoryEnabled: true,
          contactMemoryEnabled: true,
          contactMemoryCrossChannelEnabled: false,
        })),
      },
      audienceIdentity: {
        findUnique: vi.fn(async () => ({
          id: "identity-1",
          status: AudienceIdentityStatus.REGISTERED,
          mergedIntoId: null,
        })),
      },
      contactMemorySharingConsent: { findFirst: consentFindFirst },
    };

    await expect(getContactMemorySharingState({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
    }, { client: client as never })).resolves.toMatchObject({
      policyEnabled: true,
      active: false,
      blockedReason: "user_disabled",
    });
  });

  it("requires an exact one-time token for Matrix confirmation commands", () => {
    expect(resolveDeterministicContactMemorySharingCommand("!memory_share"))
      .toBe("DISCLOSE");
    expect(resolveDeterministicContactMemorySharingCommand(
      ` !MEMORY_SHARE   confirm ${challengeToken} `,
    )).toBe("GRANT");
    expect(resolveDeterministicContactMemorySharingCommand(
      "!memory_share confirm",
    )).toBe("INVALID_CONFIRM");
    expect(resolveDeterministicContactMemorySharingCommand("!memory_unshare"))
      .toBe("REVOKE");
    expect(readContactMemorySharingChallengeToken(
      `confirm ${challengeToken}`,
    )).toBe(challengeToken);
    expect(readContactMemorySharingChallengeToken("confirm")).toBeNull();
    expect(readContactMemorySharingChallengeToken("confirm short")).toBeNull();
  });

  it("persists only a hash of a short-lived exact-source challenge", async () => {
    const occurredAt = new Date("2026-08-07T01:00:00.000Z");
    const client = sharingClient();

    const result = await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-1",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => occurredAt,
      generateToken: () => challengeToken,
    });

    expect(result).toEqual({
      challengeToken,
      challengeExpiresAt: "2026-08-07T01:10:00.000Z",
      contractVersion: contactMemorySharingConsentContractVersion,
    });
    expect(client.contactMemorySharingChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        representativeId: "rep-1",
        audienceIdentityId: "identity-1",
        sourceChannel: RepresentativeChannelKind.WEB,
        policyRevision: 7,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        sourceEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        disclosureEventHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        createdAt: occurredAt,
      }),
      select: { id: true, expiresAt: true },
    });
    expect(client.contactMemorySharingSourceEventClaim.create)
      .toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: ContactMemorySharingSourceEventRole.DISCLOSURE,
          challengeId: "challenge-1",
          consentId: null,
          eventHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      });
    expect(JSON.stringify(
      client.contactMemorySharingChallenge.create.mock.calls,
    )).not.toContain(challengeToken);
    expect(client.identityLink.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(client.$executeRaw.mock.invocationCallOrder[0]!);
  });

  it("rejects a replayed disclosure provider event", async () => {
    const occurredAt = new Date("2026-08-07T01:30:00.000Z");
    const client = sharingClient();
    const input = {
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-replayed",
      ...webEvidence,
    };
    await createContactMemorySharingChallenge(input, {
      client: client as never,
      now: () => occurredAt,
      generateToken: () => challengeToken,
    });
    await expect(createContactMemorySharingChallenge(input, {
      client: client as never,
      now: () => occurredAt,
      generateToken: () => "B".repeat(43),
    })).rejects.toMatchObject({
      code: "contact_memory_sharing_conflict",
    });
  });

  it("atomically consumes once and binds consent to evidence and confirmation event", async () => {
    const disclosedAt = new Date("2026-08-07T02:00:00.000Z");
    const grantedAt = new Date("2026-08-07T02:01:00.000Z");
    const client = sharingClient({ latestConsentVersion: 1 });
    const challenge = await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-2",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => disclosedAt,
      generateToken: () => challengeToken,
    });

    await expect(grantContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      challengeToken: challenge.challengeToken,
      sourceEventKey: "web-confirmation-event-2",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => grantedAt,
    })).resolves.toMatchObject({
      active: true,
      replayed: false,
      grantedAt: grantedAt.toISOString(),
    });

    expect(client.contactMemorySharingConsent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        challengeId: "challenge-1",
        consentVersion: 2,
        sourceEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        confirmationEventHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        proofHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
      select: { id: true, grantedAt: true, sourceChannel: true },
    });
    expect(client.contactMemorySharingSourceEventClaim.create)
      .toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          role: ContactMemorySharingSourceEventRole.CONFIRMATION,
          challengeId: "challenge-1",
          consentId: "consent-1",
          eventHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      });

    await expect(grantContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      challengeToken: challenge.challengeToken,
      sourceEventKey: "web-confirmation-replay",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T02:02:00.000Z"),
    })).rejects.toMatchObject({
      code: "contact_memory_sharing_challenge_consumed",
    });
    expect(client.contactMemorySharingConsent.create).toHaveBeenCalledTimes(1);
  });

  it("revokes every pending challenge before idempotent shared cleanup", async () => {
    const occurredAt = new Date("2026-08-07T03:00:00.000Z");
    const client = sharingClient({
      activeConsentRows: [{ id: "consent-1" }, { id: "consent-2" }],
    });
    await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-3",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T02:59:00.000Z"),
      generateToken: () => challengeToken,
    });

    const result = await revokeContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      sourceChannel: "WEB",
    }, { client: client as never, now: () => occurredAt });

    expect(result).toEqual({
      active: false,
      changed: true,
      matchedMemoryCount: 0,
      queuedDeletionCount: 0,
      replayedDeletionCount: 0,
    });
    expect(client.contactMemorySharingConsent.update).toHaveBeenCalledTimes(2);
    expect(client.challengeState()?.revokedAt).toEqual(occurredAt);
  });

  it("does not let one confirmation event consume a second challenge", async () => {
    const client = sharingClient();
    const confirmationEvent = "web-confirmation-event-one-shot";
    const first = await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-first",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T04:00:00.000Z"),
      generateToken: () => challengeToken,
    });
    await grantContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      challengeToken: first.challengeToken,
      sourceEventKey: confirmationEvent,
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T04:01:00.000Z"),
    });
    const second = await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-disclosure-event-second",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T04:02:00.000Z"),
      generateToken: () => "B".repeat(43),
    });
    await expect(grantContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      challengeToken: second.challengeToken,
      sourceEventKey: confirmationEvent,
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T04:03:00.000Z"),
    })).rejects.toMatchObject({
      code: "contact_memory_sharing_conflict",
    });
  });

  it("does not let a disclosure event become a confirmation event for another challenge", async () => {
    const client = sharingClient();
    const crossRoleEvent = "web-cross-role-event";
    await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: crossRoleEvent,
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T05:00:00.000Z"),
      generateToken: () => challengeToken,
    });
    const second = await createContactMemorySharingChallenge({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      disclosureContractVersion:
        contactMemorySharingConsentContractVersion,
      sourceEventKey: "web-second-disclosure-event",
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T05:01:00.000Z"),
      generateToken: () => "B".repeat(43),
    });
    await expect(grantContactMemorySharingConsent({
      representativeSlug: "delegate",
      audienceIdentityId: "identity-1",
      challengeToken: second.challengeToken,
      sourceEventKey: crossRoleEvent,
      ...webEvidence,
    }, {
      client: client as never,
      now: () => new Date("2026-08-07T05:02:00.000Z"),
    })).rejects.toMatchObject({
      code: "contact_memory_sharing_conflict",
    });
  });
});

function sharingClient(input: {
  latestConsentVersion?: number;
  activeConsentRows?: Array<{ id: string }>;
} = {}) {
  let challengeSequence = 0;
  let consentSequence = 0;
  const disclosureEventHashes = new Set<string>();
  const confirmationEventHashes = new Set<string>();
  const claimedSourceEvents = new Set<string>();
  let challenge: {
    id: string;
    representativeId: string;
    audienceIdentityId: string;
    sourceChannel: RepresentativeChannelKind;
    policyRevision: number;
    disclosureContractVersion: string;
    tokenHash: string;
    sourceEvidenceHash: string;
    disclosureEventHash: string;
    expiresAt: Date;
    consumedAt: Date | null;
    revokedAt: Date | null;
  } | null = null;
  const contactMemorySharingChallenge = {
    create: vi.fn(async (args: {
      data: Omit<NonNullable<typeof challenge>, "id" | "consumedAt" | "revokedAt">;
    }) => {
      if (disclosureEventHashes.has(args.data.disclosureEventHash)) {
        throw prismaUniqueConflict();
      }
      disclosureEventHashes.add(args.data.disclosureEventHash);
      challengeSequence += 1;
      challenge = {
        id: `challenge-${challengeSequence}`,
        ...args.data,
        consumedAt: null,
        revokedAt: null,
      };
      return { id: challenge.id, expiresAt: challenge.expiresAt };
    }),
    findUnique: vi.fn(async () => challenge),
    updateMany: vi.fn(async (args: {
      where: { id?: string };
      data: { consumedAt?: Date; revokedAt?: Date };
    }) => {
      if (!challenge) return { count: 0 };
      if (args.where.id && args.where.id !== challenge.id) return { count: 0 };
      if (args.data.consumedAt) challenge.consumedAt = args.data.consumedAt;
      if (args.data.revokedAt) challenge.revokedAt = args.data.revokedAt;
      return { count: 1 };
    }),
  };
  const contactMemorySharingConsent = {
    findFirst: vi.fn(async (args: { where?: { status?: unknown } }) => {
      if (args.where?.status) return null;
      return input.latestConsentVersion === undefined
        ? null
        : { consentVersion: input.latestConsentVersion };
    }),
    findMany: vi.fn(async () => input.activeConsentRows ?? []),
    create: vi.fn(async (args: {
      data: {
        grantedAt: Date;
        sourceChannel: RepresentativeChannelKind;
        confirmationEventHash: string;
      };
    }) => {
      if (confirmationEventHashes.has(args.data.confirmationEventHash)) {
        throw prismaUniqueConflict();
      }
      confirmationEventHashes.add(args.data.confirmationEventHash);
      consentSequence += 1;
      return {
        id: `consent-${consentSequence}`,
        grantedAt: args.data.grantedAt,
        sourceChannel: args.data.sourceChannel,
      };
    }),
    update: vi.fn(async () => ({})),
  };
  const contactMemorySharingSourceEventClaim = {
    create: vi.fn(async (args: { data: { eventHash: string } }) => {
      if (claimedSourceEvents.has(args.data.eventHash)) {
        throw prismaUniqueConflict();
      }
      claimedSourceEvents.add(args.data.eventHash);
      return args.data;
    }),
  };
  const client = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      const challengeSnapshot = challenge ? { ...challenge } : null;
      const disclosureSnapshot = new Set(disclosureEventHashes);
      const confirmationSnapshot = new Set(confirmationEventHashes);
      const claimsSnapshot = new Set(claimedSourceEvents);
      const consentSequenceSnapshot = consentSequence;
      try {
        return await operation(client);
      } catch (error) {
        challenge = challengeSnapshot;
        disclosureEventHashes.clear();
        disclosureSnapshot.forEach((value) => disclosureEventHashes.add(value));
        confirmationEventHashes.clear();
        confirmationSnapshot.forEach((value) => confirmationEventHashes.add(value));
        claimedSourceEvents.clear();
        claimsSnapshot.forEach((value) => claimedSourceEvents.add(value));
        consentSequence = consentSequenceSnapshot;
        throw error;
      }
    },
    $queryRaw: vi.fn(async () => [{ id: challenge?.id ?? "link-1" }]),
    $executeRaw: vi.fn(async () => 1),
    representative: {
      findUnique: vi.fn(async () => ({ id: "rep-1", slug: "delegate" })),
    },
    representativeMemoryPolicy: {
      findUnique: vi.fn(async () => ({
        revision: 7,
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        contactMemoryCrossChannelEnabled: true,
      })),
    },
    audienceIdentity: {
      findUnique: vi.fn(async () => ({
        id: "identity-1",
        status: AudienceIdentityStatus.REGISTERED,
        mergedIntoId: null,
      })),
    },
    identityLink: {
      findFirst: vi.fn(async () => ({
        id: "link-1",
        verifiedAt: new Date(),
        assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
        revokedAt: null,
      })),
      findUnique: vi.fn(async (args: { where: { id?: string } }) =>
        args.where.id
          ? {
              id: "link-1",
              audienceIdentityId: "identity-1",
              provider: "LOGTO",
              providerSubject: "logto-subject-1",
              issuer: "https://issuer.example",
              connectionId: "signed-web-session-1",
              verifiedAt: new Date(),
              assuranceLevel: IdentityAssuranceLevel.PLATFORM_VERIFIED,
              revokedAt: null,
            }
          : null),
    },
    identityLinkConnectionProof: {
      findUnique: vi.fn(async () => null),
    },
    contactMemorySharingChallenge,
    contactMemorySharingConsent,
    contactMemorySharingSourceEventClaim,
    memoryCandidate: { updateMany: vi.fn(async () => ({ count: 0 })) },
    governedMemory: { findMany: vi.fn(async () => []) },
  };
  return {
    ...client,
    challengeState: () => challenge,
  };
}

function prismaUniqueConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}
