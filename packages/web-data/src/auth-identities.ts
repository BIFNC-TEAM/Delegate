import { prisma } from "./prisma";
import { resolveAuthenticatedAudienceIdentity } from "./web-audience";

export type ExternalAuthProvider = "logto";

export type ExternalAuthProfile = {
  provider: ExternalAuthProvider;
  subject: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  name?: string | null | undefined;
  emailVerified?: boolean | undefined;
  phoneVerified?: boolean | undefined;
  metadata?: unknown;
};

type OwnerIdentityLinkProviderValue = "LOGTO";
type AudienceIdentityLinkProviderValue = "LOGTO";

type OwnerIdentityLinkRecord = {
  id: string;
  ownerId: string;
  provider: OwnerIdentityLinkProviderValue;
  providerSubject: string;
  email: string | null;
  phone: string | null;
  verifiedAt: Date | null;
  metadata: unknown;
};

type OwnerRecord = {
  id: string;
  displayName: string;
  handle?: string | null;
};

type AudienceIdentityRecord = {
  id: string;
  status: string;
  lastSeenAt: Date;
};

type AuthIdentityClient = {
  ownerIdentityLink: {
    findUnique(args: {
      where: {
        provider_providerSubject: {
          provider: OwnerIdentityLinkProviderValue;
          providerSubject: string;
        };
      };
      include: { owner: true };
    }): Promise<(OwnerIdentityLinkRecord & { owner: OwnerRecord }) | null>;
  };
  owner: {
    create(args: {
      data: {
        displayName: string;
        identityLinks: {
          create: {
            provider: OwnerIdentityLinkProviderValue;
            providerSubject: string;
            email: string | null;
            phone: string | null;
            verifiedAt: Date | null;
            metadata: unknown;
          };
        };
      };
      include: { identityLinks: true };
    }): Promise<OwnerRecord & { identityLinks: OwnerIdentityLinkRecord[] }>;
  };
  audienceIdentity: {
    update(args: {
      where: { id: string };
      data: {
        status: "REGISTERED";
        lastSeenAt: Date;
      };
    }): Promise<AudienceIdentityRecord>;
  };
  identityLink: {
    upsert(args: {
      where: {
        provider_providerSubject: {
          provider: AudienceIdentityLinkProviderValue;
          providerSubject: string;
        };
      };
      update: {
        audienceIdentityId: string;
        verifiedAt: Date | null;
        metadata: unknown;
      };
      create: {
        audienceIdentityId: string;
        provider: AudienceIdentityLinkProviderValue;
        providerSubject: string;
        verifiedAt: Date | null;
        metadata: unknown;
      };
    }): Promise<unknown>;
  };
};

export type ResolveOwnerForAuthResult = {
  owner: OwnerRecord;
  identityLink: OwnerIdentityLinkRecord;
  created: boolean;
};

export async function resolveOwnerForAuth(
  profile: ExternalAuthProfile,
  client: AuthIdentityClient = prisma as unknown as AuthIdentityClient,
): Promise<ResolveOwnerForAuthResult> {
  const normalized = normalizeExternalAuthProfile(profile);
  const existingLink = await client.ownerIdentityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: normalized.ownerProvider,
        providerSubject: normalized.subject,
      },
    },
    include: { owner: true },
  });

  if (existingLink) {
    return {
      owner: existingLink.owner,
      identityLink: existingLink,
      created: false,
    };
  }

  const owner = await client.owner.create({
    data: {
      displayName: buildOwnerDisplayName(normalized),
      identityLinks: {
        create: {
          provider: normalized.ownerProvider,
          providerSubject: normalized.subject,
          email: normalized.email,
          phone: normalized.phone,
          verifiedAt: normalized.verifiedAt,
          metadata: normalized.metadata,
        },
      },
    },
    include: { identityLinks: true },
  });
  const identityLink = owner.identityLinks.find(
    (link) =>
      link.provider === normalized.ownerProvider && link.providerSubject === normalized.subject,
  );

  if (!identityLink) {
    throw new Error("Failed to create owner identity link");
  }

  return {
    owner,
    identityLink,
    created: true,
  };
}

export async function linkAudienceIdentityToAuth(
  input: {
    audienceIdentityId: string;
    profile: ExternalAuthProfile;
    now?: Date | undefined;
  },
  client: AuthIdentityClient = prisma as unknown as AuthIdentityClient,
): Promise<AudienceIdentityRecord> {
  const now = input.now ?? new Date();
  const normalized = normalizeExternalAuthProfile(input.profile, now);
  return resolveAuthenticatedAudienceIdentity(
    {
      audienceIdentityId: input.audienceIdentityId,
      provider: normalized.audienceProvider,
      providerSubject: normalized.subject,
      verifiedAt: normalized.verifiedAt,
      metadata: normalized.metadata,
      now,
    },
    client as unknown as Parameters<typeof resolveAuthenticatedAudienceIdentity>[1],
  );
}

export function normalizeAuthSubject(provider: ExternalAuthProvider, subject: string): string {
  const normalized = subject.trim();
  if (!normalized) {
    throw new Error(`${provider} subject is required`);
  }
  return normalized;
}

function normalizeExternalAuthProfile(profile: ExternalAuthProfile, verifiedAtNow = new Date()) {
  const subject = normalizeAuthSubject(profile.provider, profile.subject);
  const email = normalizeOptionalEmail(profile.email);
  const phone = normalizeOptionalText(profile.phone);
  const name = normalizeOptionalText(profile.name);

  return {
    ownerProvider: mapOwnerProvider(profile.provider),
    audienceProvider: mapAudienceProvider(profile.provider),
    subject,
    email,
    phone,
    name,
    verifiedAt: profile.emailVerified || profile.phoneVerified ? verifiedAtNow : null,
    metadata: profile.metadata ?? null,
  };
}

function buildOwnerDisplayName(profile: ReturnType<typeof normalizeExternalAuthProfile>): string {
  if (profile.name) {
    return profile.name;
  }
  if (profile.email) {
    return profile.email.split("@")[0] ?? profile.email;
  }
  if (profile.phone) {
    return profile.phone;
  }
  return `Creator ${profile.subject.slice(0, 8)}`;
}

function mapOwnerProvider(provider: ExternalAuthProvider): OwnerIdentityLinkProviderValue {
  if (provider === "logto") {
    return "LOGTO";
  }
  throw new Error(`Unsupported owner auth provider: ${provider}`);
}

function mapAudienceProvider(provider: ExternalAuthProvider): AudienceIdentityLinkProviderValue {
  if (provider === "logto") {
    return "LOGTO";
  }
  throw new Error(`Unsupported audience auth provider: ${provider}`);
}

function normalizeOptionalEmail(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
