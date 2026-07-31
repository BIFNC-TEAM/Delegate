import { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export const DELEGATE_ACCOUNT_SESSION_MODE_ENV =
  "DELEGATE_ACCOUNT_SESSION_MODE";

export type AccountSessionMode =
  | "legacy"
  | "shadow"
  | "enforce"
  | "contract";

export type VerifiedAccountPrincipal = {
  provider: "logto";
  issuer: string;
  subject: string;
  /**
   * The time at which the caller completed cryptographic verification of the
   * provider assertion. It is also persisted as lastAuthenticatedAt for this
   * callback; an OIDC auth_time claim has different semantics and is not used.
   * Decoding an unverified JWT is not sufficient.
   */
  verifiedAt: Date;
  email?: string | null | undefined;
  emailVerified?: boolean | undefined;
  phone?: string | null | undefined;
  phoneVerified?: boolean | undefined;
  displayName?: string | null | undefined;
  metadata?: Prisma.InputJsonValue | null | undefined;
};

type AccountStatusValue =
  | "ACTIVE"
  | "SUSPENDED"
  | "DELETION_PENDING"
  | "DELETED";
type AuthIdentityStatusValue = "ACTIVE" | "REVOKED";
type AuthIdentityProviderValue = "LOGTO";

export type AccountShadowRecord = {
  id: string;
  status: AccountStatusValue;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthIdentityShadowRecord = {
  id: string;
  accountId: string;
  provider: AuthIdentityProviderValue;
  issuer: string;
  subject: string;
  status: AuthIdentityStatusValue;
  email: string | null;
  emailVerifiedAt: Date | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  displayName: string | null;
  verifiedAt: Date;
  lastAuthenticatedAt: Date;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ResolvedAccountShadow = {
  account: AccountShadowRecord;
  authIdentity: AuthIdentityShadowRecord;
  created: boolean;
};

type AuthIdentityWithAccount = AuthIdentityShadowRecord & {
  account: AccountShadowRecord;
};

export type AccountShadowClient = {
  authIdentity: {
    findUnique(args: {
      where: {
        provider_issuer_subject: {
          provider: AuthIdentityProviderValue;
          issuer: string;
          subject: string;
        };
      };
      include: { account: true };
    }): Promise<AuthIdentityWithAccount | null>;
    update(args: {
      where: { id: string };
      data: {
        email: string | null;
        emailVerifiedAt: Date | null;
        phone: string | null;
        phoneVerifiedAt: Date | null;
        displayName: string | null;
        verifiedAt: Date;
        lastAuthenticatedAt: Date;
        metadata: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
      };
    }): Promise<AuthIdentityShadowRecord>;
  };
  account: {
    create(args: {
      data: {
        authIdentities: {
          create: {
            provider: AuthIdentityProviderValue;
            issuer: string;
            subject: string;
            email: string | null;
            emailVerifiedAt: Date | null;
            phone: string | null;
            phoneVerifiedAt: Date | null;
            displayName: string | null;
            verifiedAt: Date;
            lastAuthenticatedAt: Date;
            metadata: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
          };
        };
      };
      include: { authIdentities: true };
    }): Promise<AccountShadowRecord & {
      authIdentities: AuthIdentityShadowRecord[];
    }>;
  };
  $transaction?<T>(
    operation: (tx: AccountShadowClient) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export class AccountShadowUnavailableError extends Error {
  readonly code = "ACCOUNT_SHADOW_UNAVAILABLE";

  constructor(
    readonly accountStatus: AccountStatusValue,
    readonly identityStatus: AuthIdentityStatusValue,
  ) {
    super(
      `Account shadow is unavailable (account=${accountStatus}, identity=${identityStatus}).`,
    );
    this.name = "AccountShadowUnavailableError";
  }
}

/**
 * Resolves exactly one verified external principal to one provider-independent
 * Account. Email, phone, and display name are refreshed profile claims only:
 * this function never queries them and never uses them to merge Accounts.
 *
 * The service is intentionally not wired into auth routes during the shadow
 * foundation phase. Callers must opt into the finite rollout mode separately.
 */
export async function resolveAccountShadowForVerifiedPrincipal(
  principal: VerifiedAccountPrincipal,
  client: AccountShadowClient = prisma as unknown as AccountShadowClient,
): Promise<ResolvedAccountShadow> {
  const normalized = normalizeVerifiedAccountPrincipal(principal);
  const operation = async (
    tx: AccountShadowClient,
  ): Promise<ResolvedAccountShadow> => {
    const existing = await findExactAuthIdentity(tx, normalized);
    if (existing) {
      assertAvailableIdentity(existing);
      const refreshed = await tx.authIdentity.update({
        where: { id: existing.id },
        data: mutableIdentityClaims(normalized),
      });
      assertIdentityAccountConsistency(refreshed, existing.account);
      return {
        account: existing.account,
        authIdentity: refreshed,
        created: false,
      };
    }

    const account = await tx.account.create({
      data: {
        authIdentities: {
          create: {
            provider: normalized.provider,
            issuer: normalized.issuer,
            subject: normalized.subject,
            ...mutableIdentityClaims(normalized),
          },
        },
      },
      include: { authIdentities: true },
    });
    const authIdentity = account.authIdentities.find(
      (identity) =>
        identity.provider === normalized.provider
        && identity.issuer === normalized.issuer
        && identity.subject === normalized.subject,
    );
    if (!authIdentity) {
      throw new Error(
        "Account shadow creation did not return its exact AuthIdentity.",
      );
    }
    assertAvailableIdentity({ ...authIdentity, account });
    return {
      account,
      authIdentity,
      created: true,
    };
  };

  if (!client.$transaction) {
    return operation(client);
  }

  return runWithPrismaWriteConflictRetry(
    () =>
      client.$transaction!(
        operation,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    {
      // Concurrent first callbacks can race on the exact principal key. The
      // retry re-enters the transaction, observes the committed winner, and
      // returns it instead of creating or guessing another Account.
      additionalRetryableCodes: ["P2002"],
    },
  );
}

export function readAccountSessionMode(
  env: Record<string, string | undefined> = process.env,
): AccountSessionMode {
  const raw = env[DELEGATE_ACCOUNT_SESSION_MODE_ENV]?.trim().toLowerCase();
  if (!raw) {
    return "legacy";
  }
  if (
    raw === "legacy"
    || raw === "shadow"
    || raw === "enforce"
    || raw === "contract"
  ) {
    return raw;
  }
  throw new Error(
    `${DELEGATE_ACCOUNT_SESSION_MODE_ENV} must be legacy, shadow, enforce, or contract.`,
  );
}

/**
 * The v2 session reader is intentionally not active yet. Only legacy and
 * shadow may continue trusting the signed legacy cookie; enforce/contract
 * must fail closed until their v2 authority implementation ships.
 */
export function usesLegacyAccountSessionAuthority(
  mode: AccountSessionMode,
): mode is "legacy" | "shadow" {
  return mode === "legacy" || mode === "shadow";
}

function findExactAuthIdentity(
  client: AccountShadowClient,
  principal: ReturnType<typeof normalizeVerifiedAccountPrincipal>,
) {
  return client.authIdentity.findUnique({
    where: {
      provider_issuer_subject: {
        provider: principal.provider,
        issuer: principal.issuer,
        subject: principal.subject,
      },
    },
    include: { account: true },
  });
}

function mutableIdentityClaims(
  principal: ReturnType<typeof normalizeVerifiedAccountPrincipal>,
) {
  return {
    email: principal.email,
    emailVerifiedAt: principal.emailVerifiedAt,
    phone: principal.phone,
    phoneVerifiedAt: principal.phoneVerifiedAt,
    displayName: principal.displayName,
    verifiedAt: principal.verifiedAt,
    lastAuthenticatedAt: principal.verifiedAt,
    metadata: principal.metadata,
  };
}

function assertAvailableIdentity(identity: AuthIdentityWithAccount): void {
  assertIdentityAccountConsistency(identity, identity.account);
  if (
    identity.account.status !== "ACTIVE"
    || identity.status !== "ACTIVE"
  ) {
    throw new AccountShadowUnavailableError(
      identity.account.status,
      identity.status,
    );
  }
}

function assertIdentityAccountConsistency(
  identity: AuthIdentityShadowRecord,
  account: AccountShadowRecord,
): void {
  if (identity.accountId !== account.id) {
    throw new Error(
      "AuthIdentity account relation is inconsistent with its accountId.",
    );
  }
}

function normalizeVerifiedAccountPrincipal(principal: VerifiedAccountPrincipal) {
  if (principal.provider !== "logto") {
    throw new Error("Unsupported account identity provider.");
  }
  const issuer = normalizeRequiredIdentityKey(principal.issuer, "issuer");
  const subject = normalizeRequiredIdentityKey(principal.subject, "subject");
  const verifiedAt = normalizeDate(principal.verifiedAt, "verifiedAt");
  const email = normalizeOptionalText(principal.email)?.toLowerCase() ?? null;
  const phone = normalizeOptionalText(principal.phone) ?? null;
  return {
    provider: "LOGTO" as const,
    issuer,
    subject,
    email,
    emailVerifiedAt:
      email && principal.emailVerified === true ? verifiedAt : null,
    phone,
    phoneVerifiedAt:
      phone && principal.phoneVerified === true ? verifiedAt : null,
    displayName: normalizeOptionalText(principal.displayName) ?? null,
    verifiedAt,
    metadata: principal.metadata === null || principal.metadata === undefined
      ? Prisma.DbNull
      : principal.metadata,
  };
}

function normalizeRequiredIdentityKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Account identity ${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeDate(value: Date, label: string): Date {
  if (
    !(value instanceof Date)
    || !Number.isFinite(value.getTime())
  ) {
    throw new Error(`Account identity ${label} must be a valid Date.`);
  }
  return value;
}
