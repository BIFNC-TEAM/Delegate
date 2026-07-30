import { prisma } from "./prisma";

type BillingProductRecord = {
  id: string;
  representativeId: string;
  name: string;
  description: string | null;
  status: string;
};

type BillingPriceVersionRecord = {
  id: string;
  billingProductId: string;
  status: string;
  currency: string;
  amountMinor: number;
  unitName: string;
  entitlementUnits: number;
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  refundPolicy: string;
  expiryPolicy: string;
  entitlementValidityDays: number | null;
  billingProduct: BillingProductRecord;
};

export type PublicServicePackage = {
  productId: string;
  priceVersionId: string;
  name: string;
  description: string | null;
  amountCents: number;
  currency: "CNY";
  entitlementUnits: number;
  unitName: "credit";
  refundPolicy: "FULL_WHEN_UNUSED";
  expiryPolicy: "NEVER_EXPIRES";
};

export type ResolvedPublicServicePackage = PublicServicePackage & {
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  entitlementValidityDays: null;
};

type BillingProductClient = {
  billingPriceVersion: {
    findMany(args: unknown): Promise<BillingPriceVersionRecord[]>;
    findUnique(args: unknown): Promise<BillingPriceVersionRecord | null>;
  };
};

export class PublicServicePackageError extends Error {
  readonly code:
    | "SERVICE_PACKAGE_NOT_FOUND"
    | "SERVICE_PACKAGE_UNAVAILABLE"
    | "SERVICE_PACKAGE_INVALID";

  constructor(
    code: PublicServicePackageError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PublicServicePackageError";
    this.code = code;
  }
}

/**
 * Lists only packages that the public CNY checkout can fulfill safely today.
 * Invalid drafts and future expiry models stay invisible instead of allowing a
 * checkout that the aggregate entitlement account cannot represent.
 */
export async function listPublicServicePackages(
  input: {
    representativeId: string;
    currency?: "CNY";
  },
  client: BillingProductClient =
    prisma as unknown as BillingProductClient,
): Promise<PublicServicePackage[]> {
  const representativeId = input.representativeId.trim();
  if (!representativeId) {
    throw new Error("representativeId is required.");
  }
  const currency = input.currency ?? "CNY";
  const versions = await client.billingPriceVersion.findMany({
    where: {
      status: "ACTIVE",
      currency,
      billingProduct: {
        representativeId,
        status: "ACTIVE",
      },
    },
    include: {
      billingProduct: true,
    },
    orderBy: [
      { amountMinor: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  return versions.flatMap((version) => {
    try {
      return [
        serializePublicServicePackage(
          serializeFulfillableServicePackage(version),
        ),
      ];
    } catch {
      return [];
    }
  });
}

function serializePublicServicePackage(
  servicePackage: ResolvedPublicServicePackage,
): PublicServicePackage {
  return {
    productId: servicePackage.productId,
    priceVersionId: servicePackage.priceVersionId,
    name: servicePackage.name,
    description: servicePackage.description,
    amountCents: servicePackage.amountCents,
    currency: servicePackage.currency,
    entitlementUnits: servicePackage.entitlementUnits,
    unitName: servicePackage.unitName,
    refundPolicy: servicePackage.refundPolicy,
    expiryPolicy: servicePackage.expiryPolicy,
  };
}

/**
 * Resolves a browser-selected immutable price version and rechecks all sale
 * invariants on the server. No amount, entitlement quantity, or revenue split
 * is accepted from the browser.
 */
export async function resolvePublicServicePackage(
  input: {
    representativeId: string;
    billingPriceVersionId: string;
    currency?: "CNY";
  },
  client: BillingProductClient =
    prisma as unknown as BillingProductClient,
): Promise<ResolvedPublicServicePackage> {
  const representativeId = input.representativeId.trim();
  const billingPriceVersionId = input.billingPriceVersionId.trim();
  if (!representativeId) {
    throw new Error("representativeId is required.");
  }
  if (!billingPriceVersionId) {
    throw new PublicServicePackageError(
      "SERVICE_PACKAGE_NOT_FOUND",
      "billingPriceVersionId is required.",
    );
  }

  const version = await client.billingPriceVersion.findUnique({
    where: { id: billingPriceVersionId },
    include: { billingProduct: true },
  });
  if (!version) {
    throw new PublicServicePackageError(
      "SERVICE_PACKAGE_NOT_FOUND",
      "Service package price version was not found.",
    );
  }
  if (
    version.billingProduct.representativeId !== representativeId
    || version.billingProduct.status !== "ACTIVE"
    || version.status !== "ACTIVE"
    || version.currency !== (input.currency ?? "CNY")
  ) {
    throw new PublicServicePackageError(
      "SERVICE_PACKAGE_UNAVAILABLE",
      "Service package price version is not available for this representative.",
    );
  }

  return serializeFulfillableServicePackage(version);
}

function serializeFulfillableServicePackage(
  version: BillingPriceVersionRecord,
): ResolvedPublicServicePackage {
  if (!Number.isSafeInteger(version.amountMinor) || version.amountMinor <= 0) {
    throw invalidPackage("Service package amount must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(version.entitlementUnits)
    || version.entitlementUnits <= 0
  ) {
    throw invalidPackage(
      "Service package entitlement units must be a positive integer.",
    );
  }
  if (version.amountMinor % version.entitlementUnits !== 0) {
    throw invalidPackage(
      "Service package amount must divide evenly into entitlement units.",
    );
  }
  if (
    !Number.isSafeInteger(version.creatorRevenueShareBps)
    || !Number.isSafeInteger(version.platformRevenueShareBps)
    || version.creatorRevenueShareBps < 0
    || version.platformRevenueShareBps < 0
    || version.creatorRevenueShareBps + version.platformRevenueShareBps !== 10_000
  ) {
    throw invalidPackage("Service package revenue shares must total 10000 bps.");
  }
  const unitName = version.unitName.trim();
  const name = version.billingProduct.name.trim();
  if (!name) {
    throw invalidPackage("Service package name is required.");
  }
  if (unitName !== "credit") {
    throw invalidPackage("V1 service packages must use the credit unit.");
  }
  if (version.refundPolicy !== "FULL_WHEN_UNUSED") {
    throw invalidPackage("Unsupported public service package refund policy.");
  }
  if (
    version.expiryPolicy !== "NEVER_EXPIRES"
    || version.entitlementValidityDays !== null
  ) {
    throw invalidPackage("Expiring service packages are not supported in V1.");
  }

  return {
    productId: version.billingProduct.id,
    priceVersionId: version.id,
    name,
    description: version.billingProduct.description?.trim() || null,
    amountCents: version.amountMinor,
    currency: "CNY",
    entitlementUnits: version.entitlementUnits,
    unitName: "credit",
    creatorRevenueShareBps: version.creatorRevenueShareBps,
    platformRevenueShareBps: version.platformRevenueShareBps,
    refundPolicy: "FULL_WHEN_UNUSED",
    expiryPolicy: "NEVER_EXPIRES",
    entitlementValidityDays: null,
  };
}

function invalidPackage(message: string): PublicServicePackageError {
  return new PublicServicePackageError("SERVICE_PACKAGE_INVALID", message);
}
