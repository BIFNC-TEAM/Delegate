import { prisma } from "./prisma";
import { resolveAuthenticatedAudienceIdentity } from "./web-audience";

export type ExternalAuthProvider = "logto";
export type AuthIdentityIssuerMode = "shadow" | "enforce";
export type CreatorAdmissionMode = "invite_only" | "self_service";

export type ExternalAuthProfile = {
  provider: ExternalAuthProvider;
  issuer: string;
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
  issuer: string | null;
  email: string | null;
  phone: string | null;
  verifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
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
    findFirst(args: {
      where: {
        provider: OwnerIdentityLinkProviderValue;
        issuer: string | null;
        providerSubject: string;
        metadata?: {
          path: string[];
          equals: string;
        };
      };
      include: { owner: true };
    }): Promise<(OwnerIdentityLinkRecord & { owner: OwnerRecord }) | null>;
    update(args: {
      where: { id: string };
      data: {
        issuer?: string;
        email: string | null;
        phone: string | null;
        verifiedAt: Date | null;
        emailVerifiedAt: Date | null;
        phoneVerifiedAt: Date | null;
        metadata: unknown;
      };
    }): Promise<OwnerIdentityLinkRecord>;
  };
  owner: {
    create(args: {
      data: {
        displayName: string;
        identityLinks: {
          create: {
            provider: OwnerIdentityLinkProviderValue;
            providerSubject: string;
            issuer: string;
            email: string | null;
            phone: string | null;
            verifiedAt: Date | null;
            emailVerifiedAt: Date | null;
            phoneVerifiedAt: Date | null;
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

export const CREATOR_ADMISSION_REQUIRED_CODE = "CREATOR_ADMISSION_REQUIRED";
export const CREATOR_REGISTRATION_REQUIRED_CODE =
  "CREATOR_REGISTRATION_REQUIRED";

export class CreatorAdmissionRequiredError extends Error {
  readonly code = CREATOR_ADMISSION_REQUIRED_CODE;
  readonly statusCode = 403;

  constructor() {
    super("Creator access requires an invitation.");
    this.name = "CreatorAdmissionRequiredError";
  }
}

export class CreatorRegistrationRequiredError extends Error {
  readonly code = CREATOR_REGISTRATION_REQUIRED_CODE;
  readonly statusCode = 403;

  constructor() {
    super("A Creator account must be created before signing in.");
    this.name = "CreatorRegistrationRequiredError";
  }
}

export async function resolveOwnerForAuth(
  profile: ExternalAuthProfile,
  client: AuthIdentityClient = prisma as unknown as AuthIdentityClient,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolveOwnerForAuthResult> {
  return resolveOwnerForAuthOperation(profile, client, env, false);
}

export async function resolveOwnerForRegistration(
  profile: ExternalAuthProfile,
  client: AuthIdentityClient = prisma as unknown as AuthIdentityClient,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolveOwnerForAuthResult> {
  return resolveOwnerForAuthOperation(profile, client, env, true);
}

async function resolveOwnerForAuthOperation(
  profile: ExternalAuthProfile,
  client: AuthIdentityClient,
  env: Record<string, string | undefined>,
  explicitRegistration: boolean,
): Promise<ResolveOwnerForAuthResult> {
  const normalized = normalizeExternalAuthProfile(profile);
  const existingLink = await client.ownerIdentityLink.findFirst({
    where: {
      provider: normalized.ownerProvider,
      issuer: normalized.issuer,
      providerSubject: normalized.subject,
    },
    include: { owner: true },
  });

  if (existingLink) {
    const refreshedLink = await client.ownerIdentityLink.update({
      where: { id: existingLink.id },
      data: {
        issuer: normalized.issuer,
        email: normalized.email,
        phone: normalized.phone,
        verifiedAt: normalized.verifiedAt,
        emailVerifiedAt: normalized.emailVerifiedAt,
        phoneVerifiedAt: normalized.phoneVerifiedAt,
        metadata: normalized.metadata,
      },
    });
    return {
      owner: existingLink.owner,
      identityLink: refreshedLink,
      created: false,
    };
  }

  if (readAuthIdentityIssuerMode(env) === "shadow") {
    const evidencedLegacyLink = await client.ownerIdentityLink.findFirst({
      where: {
        provider: normalized.ownerProvider,
        issuer: null,
        providerSubject: normalized.subject,
        metadata: {
          path: ["issuer"],
          equals: normalized.issuer,
        },
      },
      include: { owner: true },
    });
    if (evidencedLegacyLink) {
      // Compatibility is read-only for the identity key. The bounded operator
      // backfill owns issuer mutation; this request may refresh mutable claims.
      const refreshedLink = await client.ownerIdentityLink.update({
        where: { id: evidencedLegacyLink.id },
        data: {
          email: normalized.email,
          phone: normalized.phone,
          verifiedAt: normalized.verifiedAt,
          emailVerifiedAt: normalized.emailVerifiedAt,
          phoneVerifiedAt: normalized.phoneVerifiedAt,
          metadata: normalized.metadata,
        },
      });
      return {
        owner: evidencedLegacyLink.owner,
        identityLink: refreshedLink,
        created: false,
      };
    }
  }

  const admissionMode = readCreatorAdmissionMode(env);
  const creationAllowed =
    admissionMode === "self_service"
      ? explicitRegistration
      : readCreatorAdmissionPrincipals(env).has(
          buildAuthPrincipalKey(normalized.issuer, normalized.subject),
        );
  if (!creationAllowed) {
    if (admissionMode === "self_service") {
      throw new CreatorRegistrationRequiredError();
    }
    throw new CreatorAdmissionRequiredError();
  }

  let owner: OwnerRecord & { identityLinks: OwnerIdentityLinkRecord[] };
  try {
    owner = await client.owner.create({
      data: {
        displayName: buildOwnerDisplayName(normalized),
        identityLinks: {
          create: {
            provider: normalized.ownerProvider,
            providerSubject: normalized.subject,
            issuer: normalized.issuer,
            email: normalized.email,
            phone: normalized.phone,
            verifiedAt: normalized.verifiedAt,
            emailVerifiedAt: normalized.emailVerifiedAt,
            phoneVerifiedAt: normalized.phoneVerifiedAt,
            metadata: normalized.metadata,
          },
        },
      },
      include: { identityLinks: true },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const concurrentWinner = await client.ownerIdentityLink.findFirst({
      where: {
        provider: normalized.ownerProvider,
        issuer: normalized.issuer,
        providerSubject: normalized.subject,
      },
      include: { owner: true },
    });
    if (!concurrentWinner) {
      // The legacy provider/subject key can reject a distinct issuer with the
      // same subject during expand. Never reinterpret that conflict as the
      // exact principal that won this callback.
      throw error;
    }
    return {
      owner: concurrentWinner.owner,
      identityLink: concurrentWinner,
      created: false,
    };
  }
  const identityLink = owner.identityLinks.find(
    (link) =>
      link.provider === normalized.ownerProvider
      && link.issuer === normalized.issuer
      && link.providerSubject === normalized.subject,
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

export function isCreatorAdmissionRequiredError(
  error: unknown,
): error is CreatorAdmissionRequiredError {
  return (
    error instanceof CreatorAdmissionRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === CREATOR_ADMISSION_REQUIRED_CODE)
  );
}

export function isCreatorRegistrationRequiredError(
  error: unknown,
): error is CreatorRegistrationRequiredError {
  return (
    error instanceof CreatorRegistrationRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === CREATOR_REGISTRATION_REQUIRED_CODE)
  );
}

export function readCreatorAdmissionMode(
  env: Record<string, string | undefined> = process.env,
): CreatorAdmissionMode {
  const mode = env.DELEGATE_CREATOR_ADMISSION_MODE?.trim().toLowerCase();
  if (!mode || mode === "invite_only") {
    return "invite_only";
  }
  if (mode === "self_service") {
    return "self_service";
  }
  throw new Error(
    "DELEGATE_CREATOR_ADMISSION_MODE must be invite_only or self_service.",
  );
}

export function readCreatorAdmissionPrincipals(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const legacySubjects = env.DELEGATE_CREATOR_ADMISSION_SUBJECTS?.trim();
  if (legacySubjects) {
    throw new Error(
      "DELEGATE_CREATOR_ADMISSION_SUBJECTS is unsafe across issuers; use DELEGATE_CREATOR_ADMISSION_PRINCIPALS with issuer|subject entries.",
    );
  }
  const rawPrincipals = env.DELEGATE_CREATOR_ADMISSION_PRINCIPALS?.trim();
  if (!rawPrincipals) {
    return new Set();
  }

  const principals = rawPrincipals
    .split(/[,\n]/u)
    .map((principal) => principal.trim())
    .filter(Boolean)
    .map(normalizeAdmissionPrincipal);
  return new Set(principals);
}

export function buildAuthPrincipalKey(issuer: string, subject: string): string {
  return `${normalizeAuthIssuer("logto", issuer)}|${normalizeAuthSubject("logto", subject)}`;
}

/**
 * Shadow mode is a finite compatibility window for already-signed audience
 * sessions that predate the issuer claim. New authentication and all identity
 * writes are issuer-exact in both modes. Switch to enforce only after the
 * longest legacy session has expired, then remove the legacy unique keys.
 */
export function readAuthIdentityIssuerMode(
  env: Record<string, string | undefined> = process.env,
): AuthIdentityIssuerMode {
  const mode = env.DELEGATE_AUTH_IDENTITY_ISSUER_MODE?.trim().toLowerCase();
  if (!mode || mode === "shadow") {
    return "shadow";
  }
  if (mode === "enforce") {
    return "enforce";
  }
  throw new Error(
    "DELEGATE_AUTH_IDENTITY_ISSUER_MODE must be shadow or enforce.",
  );
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
      issuer: normalized.issuer,
      verifiedAt: normalized.verifiedAt,
      metadata: normalized.metadata,
      identityIssuerMode: readAuthIdentityIssuerMode(),
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

export function normalizeAuthIssuer(provider: ExternalAuthProvider, issuer: string): string {
  const normalized = issuer.trim();
  if (!normalized) {
    throw new Error(`${provider} issuer is required`);
  }
  return normalized;
}

function normalizeExternalAuthProfile(profile: ExternalAuthProfile, verifiedAtNow = new Date()) {
  const issuer = normalizeAuthIssuer(profile.provider, profile.issuer);
  const subject = normalizeAuthSubject(profile.provider, profile.subject);
  const email = normalizeOptionalEmail(profile.email);
  const phone = normalizeOptionalText(profile.phone);
  const name = normalizeOptionalText(profile.name);
  const emailVerifiedAt =
    email && profile.emailVerified === true ? verifiedAtNow : null;
  const phoneVerifiedAt =
    phone && profile.phoneVerified === true ? verifiedAtNow : null;

  return {
    ownerProvider: mapOwnerProvider(profile.provider),
    audienceProvider: mapAudienceProvider(profile.provider),
    issuer,
    subject,
    email,
    phone,
    name,
    verifiedAt: emailVerifiedAt ?? phoneVerifiedAt,
    emailVerifiedAt,
    phoneVerifiedAt,
    metadata: buildAuthMetadata(profile.metadata, issuer),
  };
}

function buildAuthMetadata(metadata: unknown, issuer: string): Record<string, unknown> {
  if (isRecord(metadata)) {
    return {
      ...metadata,
      issuer,
    };
  }
  return {
    issuer,
    ...(metadata === undefined || metadata === null
      ? {}
      : { sourceMetadata: metadata }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAdmissionPrincipal(value: string): string {
  if (value.includes("*")) {
    throw new Error(
      "DELEGATE_CREATOR_ADMISSION_PRINCIPALS does not support wildcards.",
    );
  }
  const separator = value.lastIndexOf("|");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      "DELEGATE_CREATOR_ADMISSION_PRINCIPALS entries must use issuer|subject.",
    );
  }
  return buildAuthPrincipalKey(
    value.slice(0, separator).trim(),
    value.slice(separator + 1).trim(),
  );
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

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "P2002"
    || (
      typeof candidate.message === "string"
      && candidate.message.toLowerCase().includes("unique constraint")
    )
  );
}
