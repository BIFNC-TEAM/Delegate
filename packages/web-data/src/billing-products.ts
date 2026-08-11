import { prisma } from "./prisma";

type BillingProductRecord = {
  id: string;
  representativeId: string;
  name: string;
  description: string | null;
  kind?: string;
  sortOrder?: number;
  isRecommended?: boolean;
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
  handoffAllowance?: string;
  handoffUnits?: number | null;
  handoffServiceLevel?: string | null;
  handoffValidityDays?: number | null;
  billingProduct: BillingProductRecord;
};

type PublicCommerceSettings = {
  accessMode: "FREE" | "TRIAL_THEN_CREDITS" | "CREDITS_ONLY";
  tipsEnabled: boolean;
};

type BillingProductClient = {
  billingPriceVersion: {
    findMany(args: unknown): Promise<BillingPriceVersionRecord[]>;
    findUnique(args: unknown): Promise<BillingPriceVersionRecord | null>;
  };
  representative?: {
    findUnique(args: unknown): Promise<PublicCommerceSettings | null>;
  };
};

type PublicCommerceBase = {
  productId: string;
  priceVersionId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isRecommended: boolean;
  amountCents: number;
  currency: "CNY";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED";
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
};

export type PublicServiceCommerceProduct = PublicCommerceBase & {
  kind: "SERVICE_PACKAGE";
  unitName: "credit";
  entitlementUnits: number;
  refundPolicy: "FULL_WHEN_UNUSED";
};

export type PublicTipCommerceProduct = PublicCommerceBase & {
  kind: "TIP";
  unitName: "tip";
  entitlementUnits: 0;
  refundPolicy: "NON_REFUNDABLE";
  handoffAllowance: "NONE";
  handoffUnits: null;
  handoffServiceLevel: null;
  handoffValidityDays: null;
};

export type PublicCommerceProduct =
  | PublicServiceCommerceProduct
  | PublicTipCommerceProduct;

export type ResolvedPublicCommerceProduct = PublicCommerceProduct & {
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
};

/** @deprecated Prefer PublicCommerceProduct for the unified public catalog. */
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

/** @deprecated Prefer ResolvedPublicCommerceProduct. */
export type ResolvedPublicServicePackage = PublicServicePackage & {
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  entitlementValidityDays: null;
};

export class PublicCommerceProductError extends Error {
  readonly code:
    | "SERVICE_PACKAGE_NOT_FOUND"
    | "SERVICE_PACKAGE_UNAVAILABLE"
    | "SERVICE_PACKAGE_INVALID"
    | "COMMERCE_PRODUCT_NOT_FOUND"
    | "COMMERCE_PRODUCT_UNAVAILABLE"
    | "COMMERCE_PRODUCT_INVALID";

  constructor(
    code: PublicCommerceProductError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PublicCommerceProductError";
    this.code = code;
  }
}

// Runtime and instanceof compatibility for existing route/tests.
export { PublicCommerceProductError as PublicServicePackageError };

export async function listPublicCommerceProducts(
  input: {
    representativeId: string;
    currency?: "CNY";
  },
  client: BillingProductClient = prisma as unknown as BillingProductClient,
): Promise<PublicCommerceProduct[]> {
  const representativeId = requireRepresentativeId(input.representativeId);
  const currency = input.currency ?? "CNY";
  const settings = await loadPublicCommerceSettings(client, representativeId);
  const versions = await client.billingPriceVersion.findMany({
    where: {
      status: "ACTIVE",
      currency,
      billingProduct: {
        representativeId,
        status: "ACTIVE",
      },
    },
    include: { billingProduct: true },
    orderBy: [
      { amountMinor: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  return versions
    .flatMap((version) => {
      try {
        const product = serializeFulfillableCommerceProduct(version);
        return isProductEnabled(product.kind, settings) ? [product] : [];
      } catch {
        return [];
      }
    })
    .sort(comparePublicProducts)
    .map(stripPrivateRevenueTerms);
}

export async function resolvePublicCommerceProduct(
  input: {
    representativeId: string;
    billingPriceVersionId: string;
    currency?: "CNY";
  },
  client: BillingProductClient = prisma as unknown as BillingProductClient,
): Promise<ResolvedPublicCommerceProduct> {
  const representativeId = requireRepresentativeId(input.representativeId);
  const billingPriceVersionId = input.billingPriceVersionId.trim();
  if (!billingPriceVersionId) {
    throw new PublicCommerceProductError(
      "COMMERCE_PRODUCT_NOT_FOUND",
      "billingPriceVersionId is required.",
    );
  }
  const [settings, version] = await Promise.all([
    loadPublicCommerceSettings(client, representativeId),
    client.billingPriceVersion.findUnique({
      where: { id: billingPriceVersionId },
      include: { billingProduct: true },
    }),
  ]);
  if (!version) {
    throw new PublicCommerceProductError(
      "COMMERCE_PRODUCT_NOT_FOUND",
      "Commerce product price version was not found.",
    );
  }
  if (
    version.billingProduct.representativeId !== representativeId
    || version.billingProduct.status !== "ACTIVE"
    || version.status !== "ACTIVE"
    || version.currency !== (input.currency ?? "CNY")
  ) {
    throw new PublicCommerceProductError(
      "COMMERCE_PRODUCT_UNAVAILABLE",
      "Commerce product is not available for this representative.",
    );
  }
  const product = serializeFulfillableCommerceProduct(version);
  if (!isProductEnabled(product.kind, settings)) {
    throw new PublicCommerceProductError(
      "COMMERCE_PRODUCT_UNAVAILABLE",
      "Commerce product is disabled by the representative's current settings.",
    );
  }
  return product;
}

/** Compatibility projection for legacy service-package callers. */
export async function listPublicServicePackages(
  input: {
    representativeId: string;
    currency?: "CNY";
  },
  client: BillingProductClient = prisma as unknown as BillingProductClient,
): Promise<PublicServicePackage[]> {
  const products = await listPublicCommerceProducts(input, client);
  return products
    .filter(
      (product): product is PublicServiceCommerceProduct =>
        product.kind === "SERVICE_PACKAGE",
    )
    .map(toLegacyPublicServicePackage);
}

/** Compatibility resolver that preserves legacy error codes and shape. */
export async function resolvePublicServicePackage(
  input: {
    representativeId: string;
    billingPriceVersionId: string;
    currency?: "CNY";
  },
  client: BillingProductClient = prisma as unknown as BillingProductClient,
): Promise<ResolvedPublicServicePackage> {
  let product: ResolvedPublicCommerceProduct;
  try {
    product = await resolvePublicCommerceProduct(input, client);
  } catch (error) {
    if (!(error instanceof PublicCommerceProductError)) throw error;
    const legacyCode = error.code.endsWith("NOT_FOUND")
      ? "SERVICE_PACKAGE_NOT_FOUND"
      : error.code.endsWith("UNAVAILABLE")
        ? "SERVICE_PACKAGE_UNAVAILABLE"
        : "SERVICE_PACKAGE_INVALID";
    throw new PublicCommerceProductError(legacyCode, error.message);
  }
  if (product.kind !== "SERVICE_PACKAGE") {
    throw new PublicCommerceProductError(
      "SERVICE_PACKAGE_UNAVAILABLE",
      "The selected price version is not a service package.",
    );
  }
  return {
    ...toLegacyPublicServicePackage(product),
    creatorRevenueShareBps: product.creatorRevenueShareBps,
    platformRevenueShareBps: product.platformRevenueShareBps,
    entitlementValidityDays: null,
  };
}

function serializeFulfillableCommerceProduct(
  version: BillingPriceVersionRecord,
): ResolvedPublicCommerceProduct {
  if (!Number.isSafeInteger(version.amountMinor) || version.amountMinor <= 0) {
    throw invalidProduct("Commerce product amount must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(version.creatorRevenueShareBps)
    || !Number.isSafeInteger(version.platformRevenueShareBps)
    || version.creatorRevenueShareBps < 0
    || version.platformRevenueShareBps < 0
    || version.creatorRevenueShareBps + version.platformRevenueShareBps !== 10_000
  ) {
    throw invalidProduct("Commerce product revenue shares must total 10000 bps.");
  }
  if (
    version.expiryPolicy !== "NEVER_EXPIRES"
    || version.entitlementValidityDays !== null
  ) {
    throw invalidProduct("Expiring commerce products are not supported.");
  }
  const name = version.billingProduct.name.trim();
  if (!name) throw invalidProduct("Commerce product name is required.");
  const common = {
    productId: version.billingProduct.id,
    priceVersionId: version.id,
    name,
    description: version.billingProduct.description?.trim() || null,
    sortOrder: normalizeSortOrder(version.billingProduct.sortOrder),
    isRecommended: version.billingProduct.isRecommended === true,
    amountCents: version.amountMinor,
    currency: "CNY" as const,
    expiryPolicy: "NEVER_EXPIRES" as const,
    entitlementValidityDays: null,
    creatorRevenueShareBps: version.creatorRevenueShareBps,
    platformRevenueShareBps: version.platformRevenueShareBps,
  };
  const kind = version.billingProduct.kind ?? "SERVICE_PACKAGE";
  const allowance = version.handoffAllowance ?? "NONE";

  if (kind === "TIP") {
    if (
      version.unitName.trim() !== "tip"
      || version.entitlementUnits !== 0
      || version.refundPolicy !== "NON_REFUNDABLE"
      || allowance !== "NONE"
      || version.handoffUnits != null
      || version.handoffServiceLevel != null
      || version.handoffValidityDays != null
    ) {
      throw invalidProduct("Tip terms are inconsistent or grant an entitlement.");
    }
    return {
      ...common,
      kind: "TIP",
      unitName: "tip",
      entitlementUnits: 0,
      refundPolicy: "NON_REFUNDABLE",
      handoffAllowance: "NONE",
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    };
  }
  if (kind !== "SERVICE_PACKAGE") {
    throw invalidProduct("Unsupported commerce product kind.");
  }
  if (
    version.unitName.trim() !== "credit"
    || !Number.isSafeInteger(version.entitlementUnits)
    || version.entitlementUnits <= 0
    || version.refundPolicy !== "FULL_WHEN_UNUSED"
  ) {
    throw invalidProduct("Service-package credit terms are invalid.");
  }
  const handoff = normalizeHandoffTerms(version, allowance);
  return {
    ...common,
    kind: "SERVICE_PACKAGE",
    unitName: "credit",
    entitlementUnits: version.entitlementUnits,
    refundPolicy: "FULL_WHEN_UNUSED",
    ...handoff,
  };
}

function normalizeHandoffTerms(
  version: BillingPriceVersionRecord,
  allowance: string,
): Pick<
  PublicServiceCommerceProduct,
  | "handoffAllowance"
  | "handoffUnits"
  | "handoffServiceLevel"
  | "handoffValidityDays"
> {
  if (allowance === "NONE") {
    if (
      version.handoffUnits != null
      || version.handoffServiceLevel != null
      || version.handoffValidityDays != null
    ) {
      throw invalidProduct("A no-handoff package contains handoff terms.");
    }
    return {
      handoffAllowance: "NONE",
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    };
  }
  if (
    (allowance !== "LIMITED" && allowance !== "UNLIMITED")
    || (version.handoffServiceLevel !== "STANDARD"
      && version.handoffServiceLevel !== "PRIORITY")
    || !Number.isSafeInteger(version.handoffValidityDays)
    || (version.handoffValidityDays ?? 0) <= 0
  ) {
    throw invalidProduct("Handoff service level or validity is invalid.");
  }
  if (
    allowance === "LIMITED"
    && (!Number.isSafeInteger(version.handoffUnits)
      || (version.handoffUnits ?? 0) <= 0)
  ) {
    throw invalidProduct("Limited handoff access requires a positive use count.");
  }
  if (allowance === "UNLIMITED" && version.handoffUnits != null) {
    throw invalidProduct("Unlimited handoff access cannot have a use count.");
  }
  return {
    handoffAllowance: allowance,
    handoffUnits: allowance === "LIMITED" ? version.handoffUnits! : null,
    handoffServiceLevel: version.handoffServiceLevel,
    handoffValidityDays: version.handoffValidityDays!,
  };
}

async function loadPublicCommerceSettings(
  client: BillingProductClient,
  representativeId: string,
): Promise<PublicCommerceSettings> {
  // The fallback preserves compatibility with narrow unit-test clients and
  // legacy internal adapters. The production Prisma client always rechecks.
  if (!client.representative?.findUnique) {
    return { accessMode: "TRIAL_THEN_CREDITS", tipsEnabled: false };
  }
  const representative = await client.representative.findUnique({
    where: { id: representativeId },
    select: { accessMode: true, tipsEnabled: true },
  });
  if (!representative) {
    throw new PublicCommerceProductError(
      "COMMERCE_PRODUCT_UNAVAILABLE",
      "Representative commerce settings were not found.",
    );
  }
  return representative;
}

function isProductEnabled(
  kind: PublicCommerceProduct["kind"],
  settings: PublicCommerceSettings,
) {
  return kind === "TIP"
    ? settings.tipsEnabled
    : settings.accessMode !== "FREE";
}

function stripPrivateRevenueTerms(
  product: ResolvedPublicCommerceProduct,
): PublicCommerceProduct {
  const {
    creatorRevenueShareBps: _creatorRevenueShareBps,
    platformRevenueShareBps: _platformRevenueShareBps,
    ...publicProduct
  } = product;
  return publicProduct;
}

function comparePublicProducts(
  left: ResolvedPublicCommerceProduct,
  right: ResolvedPublicCommerceProduct,
) {
  return left.sortOrder - right.sortOrder
    || Number(right.isRecommended) - Number(left.isRecommended)
    || left.amountCents - right.amountCents
    || left.priceVersionId.localeCompare(right.priceVersionId);
}

function toLegacyPublicServicePackage(
  product: PublicServiceCommerceProduct,
): PublicServicePackage {
  return {
    productId: product.productId,
    priceVersionId: product.priceVersionId,
    name: product.name,
    description: product.description,
    amountCents: product.amountCents,
    currency: product.currency,
    entitlementUnits: product.entitlementUnits,
    unitName: "credit",
    refundPolicy: "FULL_WHEN_UNUSED",
    expiryPolicy: "NEVER_EXPIRES",
  };
}

function normalizeSortOrder(value: number | undefined) {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

function requireRepresentativeId(value: string) {
  const representativeId = value.trim();
  if (!representativeId) throw new Error("representativeId is required.");
  return representativeId;
}

function invalidProduct(message: string): PublicCommerceProductError {
  return new PublicCommerceProductError("COMMERCE_PRODUCT_INVALID", message);
}
