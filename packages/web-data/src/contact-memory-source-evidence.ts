import {
  AudienceIdentityStatus,
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
} from "@prisma/client";

import { matrixServerNameFromUserId, normalizeMatrixUserId } from "./matrix-identifiers";

const verifiedAssuranceLevels = new Set<IdentityAssuranceLevel>([
  IdentityAssuranceLevel.PLATFORM_VERIFIED,
  IdentityAssuranceLevel.STEP_UP_VERIFIED,
]);

export type ExactMessageIdentityEvidence = {
  canonicalAudienceIdentityId: string;
  identityLinkId: string;
  identityConnectionProofId: string | null;
  provider: IdentityLinkProvider;
  providerSubject: string;
  issuer: string;
  connectionId: string | null;
  sourceChannel: RepresentativeChannelKind;
};

export type IngressIdentityProvenance = {
  sourceIdentityLinkId: string;
  sourceIdentityConnectionProofId: string | null;
};

/**
 * Resolves the exact, current server-side identity evidence at message ingress.
 * Private-channel coordinates are derived from the persisted channel binding
 * and provider sender, never from caller supplied identity ids. The selected
 * rows are held FOR SHARE until the ingress transaction commits so unlinking
 * cannot race the durable Message provenance.
 */
export async function resolveAndLockIngressIdentityProvenance(
  tx: Prisma.TransactionClient,
  input: {
    sourceChannel: RepresentativeChannelKind;
    audienceIdentityId: string | null;
    senderId: string | null;
    connectionId: string | null;
    webIdentityLinkId?: string | null;
  },
): Promise<IngressIdentityProvenance | null> {
  const sourceChannel = input.sourceChannel;
  const audienceIdentityId = input.audienceIdentityId?.trim();
  if (!audienceIdentityId) return null;

  if (sourceChannel === RepresentativeChannelKind.WEB) {
    const identityLinkId = input.webIdentityLinkId?.trim();
    if (!identityLinkId) return null;
    const evidence = await lockAndLoadExactEvidenceRows(tx, {
      identityLinkId,
      identityConnectionProofId: null,
    });
    if (
      !evidence
      || evidence.link.provider !== IdentityLinkProvider.LOGTO
      || !isCurrentVerifiedLink(evidence.link)
    ) return null;
    const [expectedCanonicalId, linkedCanonicalId] = await Promise.all([
      resolveCanonicalRegisteredIdentityId(tx, audienceIdentityId),
      resolveCanonicalRegisteredIdentityId(tx, evidence.link.audienceIdentityId),
    ]);
    if (!expectedCanonicalId || expectedCanonicalId !== linkedCanonicalId) {
      return null;
    }
    return {
      sourceIdentityLinkId: evidence.link.id,
      sourceIdentityConnectionProofId: null,
    };
  }

  const senderId = input.senderId?.trim();
  const connectionId = input.connectionId?.trim();
  if (!senderId || !connectionId) return null;
  const provider = sourceChannel === RepresentativeChannelKind.MATRIX
    ? IdentityLinkProvider.MATRIX
    : sourceChannel === RepresentativeChannelKind.TELEGRAM
      ? IdentityLinkProvider.TELEGRAM
      : null;
  if (!provider) return null;
  const providerSubject = provider === IdentityLinkProvider.MATRIX
    ? normalizeMatrixUserId(senderId)
    : senderId;
  const issuer = provider === IdentityLinkProvider.MATRIX
    ? matrixServerNameFromUserId(providerSubject)
    : "delegate-managed-bot";
  const link = await tx.identityLink.findUnique({
    where: {
      provider_providerSubject: { provider, providerSubject },
    },
    select: { id: true },
  });
  if (!link) return null;
  const proof = await tx.identityLinkConnectionProof.findUnique({
    where: {
      identityLinkId_issuer_connectionId: {
        identityLinkId: link.id,
        issuer,
        connectionId,
      },
    },
    select: { id: true },
  });
  if (!proof) return null;
  const evidence = await lockAndLoadExactEvidenceRows(tx, {
    identityLinkId: link.id,
    identityConnectionProofId: proof.id,
  });
  if (
    !evidence
    || !isCurrentVerifiedLink(evidence.link)
    || !isCurrentVerifiedProof(evidence.proof)
    || evidence.link.provider !== provider
    || evidence.link.providerSubject !== providerSubject
    || evidence.link.issuer !== issuer
    || evidence.proof?.identityLinkId !== evidence.link.id
    || evidence.proof.issuer !== issuer
    || evidence.proof.connectionId !== connectionId
  ) return null;
  const [expectedCanonicalId, linkedCanonicalId] = await Promise.all([
    resolveCanonicalActiveIdentityId(tx, audienceIdentityId),
    resolveCanonicalActiveIdentityId(tx, evidence.link.audienceIdentityId),
  ]);
  if (!expectedCanonicalId || expectedCanonicalId !== linkedCanonicalId) {
    return null;
  }
  return {
    sourceIdentityLinkId: evidence.link.id,
    sourceIdentityConnectionProofId: evidence.proof.id,
  };
}

/**
 * Acquires the exact ingress link/proof rows before the shared/contact memory
 * locks and revalidates every authoritative coordinate. Callers must next take
 * the CONTACT_SHARED lock, then the CONTACT_CHANNEL lock, and keep this same
 * transaction open through the protected database or provider operation.
 */
export async function lockAndResolveExactMessageIdentityEvidence(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    contactId: string;
    conversationId: string;
    messageId: string;
    sourceChannel: RepresentativeChannelKind;
  },
): Promise<ExactMessageIdentityEvidence | null> {
  // Some application lanes (and their deliberately narrow transaction test
  // doubles) do not use CONTACT_SHARED at all. Missing exact-evidence access
  // must therefore disable only the shared lane rather than breaking existing
  // CONTACT_CHANNEL / REPRESENTATIVE recall. A real Prisma transaction always
  // exposes this delegate; shared admission remains fail-closed below.
  if (typeof tx.message?.findFirst !== "function") return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      senderType: MessageSenderType.AUDIENCE,
      conversation: {
        representativeId: input.representativeId,
        contactId: input.contactId,
      },
    },
    select: {
      senderId: true,
      sourceIdentityLinkId: true,
      sourceIdentityConnectionProofId: true,
      conversation: {
        select: {
          audienceIdentityId: true,
          contact: { select: { audienceIdentityId: true } },
        },
      },
      channelBinding: {
        select: {
          kind: true,
          connectionId: true,
        },
      },
    },
  });
  if (!message?.sourceIdentityLinkId) return null;
  if (
    input.sourceChannel !== RepresentativeChannelKind.WEB
      ? message.channelBinding?.kind !== input.sourceChannel
      : message.channelBinding
        && message.channelBinding.kind !== RepresentativeChannelKind.WEB
  ) return null;

  const evidence = await lockAndLoadExactEvidenceRows(tx, {
    identityLinkId: message.sourceIdentityLinkId,
    identityConnectionProofId:
      message.sourceIdentityConnectionProofId,
  });
  if (!evidence || !isCurrentVerifiedLink(evidence.link)) return null;

  const expectedProvider = providerForChannel(input.sourceChannel);
  if (!expectedProvider || evidence.link.provider !== expectedProvider) {
    return null;
  }
  const expectedCanonicalIds = await Promise.all([
    resolveCanonicalRegisteredIdentityId(
      tx,
      message.conversation.audienceIdentityId ?? "",
    ),
    resolveCanonicalRegisteredIdentityId(
      tx,
      message.conversation.contact.audienceIdentityId ?? "",
    ),
    resolveCanonicalRegisteredIdentityId(tx, evidence.link.audienceIdentityId),
  ]);
  const canonicalAudienceIdentityId = expectedCanonicalIds[0];
  if (
    !canonicalAudienceIdentityId
    || expectedCanonicalIds.some((id) => id !== canonicalAudienceIdentityId)
  ) return null;

  if (input.sourceChannel === RepresentativeChannelKind.WEB) {
    if (message.sourceIdentityConnectionProofId !== null) return null;
    return {
      canonicalAudienceIdentityId,
      identityLinkId: evidence.link.id,
      identityConnectionProofId: null,
      provider: evidence.link.provider,
      providerSubject: evidence.link.providerSubject,
      issuer: evidence.link.issuer,
      connectionId: null,
      sourceChannel: input.sourceChannel,
    };
  }

  const proof = evidence.proof;
  const providerSubject = message.senderId?.trim();
  const connectionId = message.channelBinding?.connectionId?.trim();
  if (
    !proof
    || !isCurrentVerifiedProof(proof)
    || proof.identityLinkId !== evidence.link.id
    || !providerSubject
    || evidence.link.providerSubject !== (
      input.sourceChannel === RepresentativeChannelKind.MATRIX
        ? normalizeMatrixUserId(providerSubject)
        : providerSubject
    )
    || !connectionId
    || proof.connectionId !== connectionId
    || proof.issuer !== evidence.link.issuer
    || (
      input.sourceChannel === RepresentativeChannelKind.MATRIX
      && evidence.link.issuer
        !== matrixServerNameFromUserId(evidence.link.providerSubject)
    )
    || (
      input.sourceChannel === RepresentativeChannelKind.TELEGRAM
      && evidence.link.issuer !== "delegate-managed-bot"
    )
  ) return null;

  return {
    canonicalAudienceIdentityId,
    identityLinkId: evidence.link.id,
    identityConnectionProofId: proof.id,
    provider: evidence.link.provider,
    providerSubject: evidence.link.providerSubject,
    issuer: evidence.link.issuer,
    connectionId: proof.connectionId,
    sourceChannel: input.sourceChannel,
  };
}

async function lockAndLoadExactEvidenceRows(
  tx: Prisma.TransactionClient,
  input: {
    identityLinkId: string;
    identityConnectionProofId: string | null;
  },
) {
  const lockedLink = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "IdentityLink"
    WHERE "id" = ${input.identityLinkId}
    FOR SHARE
  `);
  if (lockedLink.length !== 1) return null;
  if (input.identityConnectionProofId) {
    const lockedProof = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "IdentityLinkConnectionProof"
      WHERE "id" = ${input.identityConnectionProofId}
      FOR SHARE
    `);
    if (lockedProof.length !== 1) return null;
  }
  const [link, proof] = await Promise.all([
    tx.identityLink.findUnique({
      where: { id: input.identityLinkId },
      select: {
        id: true,
        audienceIdentityId: true,
        provider: true,
        providerSubject: true,
        issuer: true,
        verifiedAt: true,
        assuranceLevel: true,
        revokedAt: true,
      },
    }),
    input.identityConnectionProofId
      ? tx.identityLinkConnectionProof.findUnique({
          where: { id: input.identityConnectionProofId },
          select: {
            id: true,
            identityLinkId: true,
            issuer: true,
            connectionId: true,
            verifiedAt: true,
            assuranceLevel: true,
            revokedAt: true,
          },
        })
      : Promise.resolve(null),
  ]);
  return link ? { link, proof } : null;
}

async function resolveCanonicalRegisteredIdentityId(
  tx: Prisma.TransactionClient,
  initialId: string,
): Promise<string | null> {
  const identity = await resolveCanonicalActiveIdentity(tx, initialId);
  return identity?.status === AudienceIdentityStatus.REGISTERED
    ? identity.id
    : null;
}

async function resolveCanonicalActiveIdentityId(
  tx: Prisma.TransactionClient,
  initialId: string,
): Promise<string | null> {
  return (await resolveCanonicalActiveIdentity(tx, initialId))?.id ?? null;
}

async function resolveCanonicalActiveIdentity(
  tx: Prisma.TransactionClient,
  initialId: string,
): Promise<{
  id: string;
  status: AudienceIdentityStatus;
} | null> {
  let identityId = initialId.trim();
  if (!identityId) return null;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(identityId)) return null;
    visited.add(identityId);
    const identity = await tx.audienceIdentity.findUnique({
      where: { id: identityId },
      select: { id: true, status: true, mergedIntoId: true },
    });
    if (!identity || identity.status === AudienceIdentityStatus.DISABLED) {
      return null;
    }
    if (
      identity.status === AudienceIdentityStatus.MERGED
      && identity.mergedIntoId
    ) {
      identityId = identity.mergedIntoId;
      continue;
    }
    return (
      identity.status === AudienceIdentityStatus.ANONYMOUS
      || identity.status === AudienceIdentityStatus.REGISTERED
    ) && !identity.mergedIntoId
      ? { id: identity.id, status: identity.status }
      : null;
  }
  return null;
}

function providerForChannel(channel: RepresentativeChannelKind) {
  if (channel === RepresentativeChannelKind.WEB) {
    return IdentityLinkProvider.LOGTO;
  }
  if (channel === RepresentativeChannelKind.MATRIX) {
    return IdentityLinkProvider.MATRIX;
  }
  if (channel === RepresentativeChannelKind.TELEGRAM) {
    return IdentityLinkProvider.TELEGRAM;
  }
  return null;
}

function isCurrentVerifiedLink(input: {
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
}) {
  return Boolean(
    input.verifiedAt
    && !input.revokedAt
    && verifiedAssuranceLevels.has(input.assuranceLevel),
  );
}

function isCurrentVerifiedProof(input: {
  verifiedAt: Date | null;
  assuranceLevel: IdentityAssuranceLevel;
  revokedAt: Date | null;
} | null): input is NonNullable<typeof input> {
  return Boolean(
    input?.verifiedAt
    && !input.revokedAt
    && verifiedAssuranceLevels.has(input.assuranceLevel),
  );
}
