import { createHash, randomUUID } from "node:crypto";

import {
  BillingEntitlementExpiryPolicy,
  BillingHandoffAllowance,
  BillingHandoffServiceLevel,
  BillingPriceVersionStatus,
  BillingProductKind,
  BillingProductStatus,
  BillingRefundPolicy,
  EventType,
  Prisma,
  RepresentativeAccessMode,
  RepresentativeHandoffAccessMode,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";

import { normalizeCreatorRevenueShareBps } from "./agent-wallet-revenue-policy";
import { prisma } from "./prisma";

const maximumSerializableAttempts = 3;
const maximumProductNameLength = 80;
const maximumProductDescriptionLength = 500;
const maximumRequestTokenLength = 191;

const priceInputSchema = z
  .object({
    amountMinor: z.number().int().min(1).max(1_000_000),
    entitlementUnits: z.number().int().min(0).max(10_000_000).optional(),
    handoffAllowance: z
      .enum(["NONE", "LIMITED", "UNLIMITED"])
      .optional(),
    handoffUnits: z.number().int().min(1).max(1_000_000).nullable().optional(),
    handoffServiceLevel: z
      .enum(["STANDARD", "PRIORITY"])
      .nullable()
      .optional(),
    handoffValidityDays: z
      .number()
      .int()
      .min(1)
      .max(3_650)
      .nullable()
      .optional(),
  })
  .strict();

const createProductInputSchema = z
  .object({
    kind: z.enum(["SERVICE_PACKAGE", "TIP"]).optional(),
    name: z.string().trim().min(1).max(maximumProductNameLength),
    description: z
      .string()
      .trim()
      .max(maximumProductDescriptionLength)
      .nullable()
      .optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    isRecommended: z.boolean().optional(),
    price: priceInputSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    kind: input.kind ?? "SERVICE_PACKAGE" as const,
    description: input.description?.trim() || null,
    sortOrder: input.sortOrder ?? 0,
    isRecommended: input.isRecommended ?? false,
  }));

const updateProductInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    name: z.string().trim().min(1).max(maximumProductNameLength),
    description: z
      .string()
      .trim()
      .max(maximumProductDescriptionLength)
      .nullable()
      .optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    isRecommended: z.boolean().optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    description: input.description?.trim() || null,
  }));

const publishPriceInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    expectedActivePriceVersionId: z
      .string()
      .trim()
      .min(1)
      .max(maximumRequestTokenLength),
    price: priceInputSchema,
  })
  .strict();

const archiveProductInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
  })
  .strict();

const commerceSettingsInputSchema = z
  .object({
    accessMode: z.enum(["FREE", "TRIAL_THEN_CREDITS", "CREDITS_ONLY"]).optional(),
    handoffAccessMode: z.enum(["FREE", "PACKAGE_REQUIRED"]).optional(),
    tipsEnabled: z.boolean().optional(),
    freeReplyLimit: z.number().int().min(0).max(1_000_000).optional(),
    humanInLoop: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one commerce setting is required.",
  });

const billingPriceVersionSelect = {
  id: true,
  version: true,
  status: true,
  currency: true,
  amountMinor: true,
  unitName: true,
  entitlementUnits: true,
  creatorRevenueShareBps: true,
  platformRevenueShareBps: true,
  refundPolicy: true,
  expiryPolicy: true,
  entitlementValidityDays: true,
  handoffAllowance: true,
  handoffUnits: true,
  handoffServiceLevel: true,
  handoffValidityDays: true,
  publishedAt: true,
  retiredAt: true,
  createdAt: true,
} satisfies Prisma.BillingPriceVersionSelect;

const billingProductSelect = {
  id: true,
  representativeId: true,
  code: true,
  name: true,
  description: true,
  kind: true,
  sortOrder: true,
  isRecommended: true,
  status: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  priceVersions: {
    select: billingPriceVersionSelect,
    orderBy: [{ version: "desc" as const }, { id: "desc" as const }],
  },
} satisfies Prisma.BillingProductSelect;

type BillingProductRecord = Prisma.BillingProductGetPayload<{
  select: typeof billingProductSelect;
}>;

type BillingReadClient = Pick<
  Prisma.TransactionClient,
  "billingProduct" | "eventAudit" | "representative"
>;

export type OwnerBillingPriceVersion = {
  id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  currency: "CNY";
  amountMinor: number;
  unitName: "credit" | "tip";
  entitlementUnits: number;
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  refundPolicy: "FULL_WHEN_UNUSED" | "NON_REFUNDABLE";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED";
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
};

export type OwnerBillingProduct = {
  id: string;
  representativeId: string;
  code: string;
  name: string;
  description: string | null;
  kind: "SERVICE_PACKAGE" | "TIP";
  sortOrder: number;
  isRecommended: boolean;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  revision: number;
  activePriceVersion: OwnerBillingPriceVersion | null;
  priceVersions: OwnerBillingPriceVersion[];
  createdAt: string;
  updatedAt: string;
};

export type OwnerBillingCatalog = {
  representative: {
    id: string;
    slug: string;
    name: string;
    accessMode: "FREE" | "TRIAL_THEN_CREDITS" | "CREDITS_ONLY";
    handoffAccessMode: "FREE" | "PACKAGE_REQUIRED";
    tipsEnabled: boolean;
    freeReplyLimit: number;
    humanInLoop: boolean;
  };
  revenueSharePolicy: {
    currency: "CNY";
    creatorRevenueShareBps: number;
    platformRevenueShareBps: number;
  } | null;
  products: OwnerBillingProduct[];
};

export type OwnerRepresentativeCommerceSettings =
  OwnerBillingCatalog["representative"];

export type OwnerBillingMutationMetadata = {
  ownerId: string;
  representativeSlug: string;
  requestId: string;
  idempotencyKey: string;
};

export class OwnerBillingProductError extends Error {
  readonly code:
    | "billing_product_invalid"
    | "billing_product_not_found"
    | "billing_product_conflict"
    | "billing_product_idempotency_conflict";
  readonly statusCode: 400 | 404 | 409;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    code: OwnerBillingProductError["code"],
    message: string,
    statusCode: OwnerBillingProductError["statusCode"],
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "OwnerBillingProductError";
    this.code = code;
    this.statusCode = statusCode;
    if (fieldErrors) {
      this.fieldErrors = fieldErrors;
    }
  }
}

export async function getOwnerRepresentativeBillingCatalog(
  input: {
    ownerId: string;
    representativeSlug: string;
  },
  client: PrismaClient = prisma,
): Promise<OwnerBillingCatalog> {
  const ownerId = requireRequestToken(input.ownerId, "ownerId");
  const representativeSlug = requireRequestToken(
    input.representativeSlug,
    "representativeSlug",
  );
  const representative = await client.representative.findFirst({
    where: {
      ownerId,
      slug: representativeSlug,
    },
    select: {
      id: true,
      slug: true,
      displayName: true,
      accessMode: true,
      handoffAccessMode: true,
      tipsEnabled: true,
      freeReplyLimit: true,
      humanInLoop: true,
      agentWallet: {
        select: {
          currency: true,
          creatorRevenueShareBps: true,
        },
      },
      billingProducts: {
        select: billingProductSelect,
        orderBy: [
          { status: "asc" },
          { sortOrder: "asc" },
          { updatedAt: "desc" },
          { id: "asc" },
        ],
      },
    },
  });
  if (!representative) {
    throw billingProductNotFound();
  }

  return {
    representative: {
      id: representative.id,
      slug: representative.slug,
      name: representative.displayName,
      accessMode: representative.accessMode,
      handoffAccessMode: representative.handoffAccessMode,
      tipsEnabled: representative.tipsEnabled,
      freeReplyLimit: representative.freeReplyLimit,
      humanInLoop: representative.humanInLoop,
    },
    revenueSharePolicy: serializeRepresentativeRevenueSharePolicy(
      representative,
    ),
    products: representative.billingProducts.map(serializeBillingProduct),
  };
}

export async function createAndPublishOwnerBillingProduct(
  input: OwnerBillingMutationMetadata & {
    product: unknown;
  },
  client: PrismaClient = prisma,
): Promise<OwnerBillingProduct> {
  const metadata = normalizeMutationMetadata(input);
  const product = parseMutation(createProductInputSchema, input.product);
  const requestHash = hashBillingRequest("create_and_publish", {
    representativeSlug: metadata.representativeSlug,
    product,
  });

  return executeBillingMutation({
    client,
    metadata,
    expectedType: EventType.BILLING_PRODUCT_CREATED,
    requestHash,
    operation: async (tx) => {
      const replay = await findBillingReplay(
        tx,
        metadata,
        EventType.BILLING_PRODUCT_CREATED,
        requestHash,
      );
      if (replay) {
        return loadScopedBillingProduct(
          tx,
          replay.representativeId,
          replay.productId,
        );
      }

      const representative = await findScopedRepresentative(tx, metadata);
      const commercialTerms = commercialPriceData(
        product.kind,
        product.price,
        resolveRepresentativeRevenueShareBps(representative),
      );
      assertProductCanBePublished(
        representative,
        product.kind,
        commercialTerms.handoffAllowance,
      );
      const now = new Date();
      const createdProduct = await tx.billingProduct.create({
        data: {
          representativeId: representative.id,
          code: `${product.kind === "TIP" ? "tip" : "service-package"}-${randomUUID()}`,
          name: product.name,
          description: product.description,
          kind: product.kind,
          sortOrder: product.sortOrder,
          isRecommended: product.isRecommended,
          status: BillingProductStatus.DRAFT,
          revision: 0,
        },
        select: { id: true },
      });
      const createdPrice = await tx.billingPriceVersion.create({
        data: {
          billingProductId: createdProduct.id,
          version: 1,
          status: BillingPriceVersionStatus.DRAFT,
          ...commercialTerms,
        },
        select: { id: true },
      });

      await tx.billingProduct.update({
        where: { id: createdProduct.id },
        data: {
          status: BillingProductStatus.ACTIVE,
          revision: { increment: 1 },
        },
      });
      await tx.billingPriceVersion.update({
        where: { id: createdPrice.id },
        data: {
          status: BillingPriceVersionStatus.ACTIVE,
          publishedAt: now,
        },
      });
      await createBillingAudit(tx, {
        metadata,
        representativeId: representative.id,
        type: EventType.BILLING_PRODUCT_CREATED,
        requestHash,
        payload: {
          operation: "create_and_publish",
          productId: createdProduct.id,
          productKind: product.kind,
          priceVersionId: createdPrice.id,
          version: 1,
          status: "ACTIVE",
          resultingRevision: 1,
        },
      });
      return loadScopedBillingProduct(
        tx,
        representative.id,
        createdProduct.id,
      );
    },
  });
}

export async function updateOwnerBillingProduct(
  input: OwnerBillingMutationMetadata & {
    productId: string;
    product: unknown;
  },
  client: PrismaClient = prisma,
): Promise<OwnerBillingProduct> {
  const metadata = normalizeMutationMetadata(input);
  const productId = requireRequestToken(input.productId, "productId");
  const product = parseMutation(updateProductInputSchema, input.product);
  const requestHash = hashBillingRequest("update_product", {
    representativeSlug: metadata.representativeSlug,
    productId,
    ...product,
  });

  return executeBillingMutation({
    client,
    metadata,
    expectedType: EventType.BILLING_PRODUCT_UPDATED,
    requestHash,
    operation: async (tx) => {
      const replay = await findBillingReplay(
        tx,
        metadata,
        EventType.BILLING_PRODUCT_UPDATED,
        requestHash,
      );
      if (replay) {
        return loadScopedBillingProduct(
          tx,
          replay.representativeId,
          replay.productId,
        );
      }

      const representative = await findScopedRepresentative(tx, metadata);
      await lockScopedBillingProduct(
        tx,
        representative.id,
        productId,
      );
      const current = await loadScopedBillingProductRecord(
        tx,
        representative.id,
        productId,
      );
      assertExpectedRevision(current, product.expectedRevision);
      if (current.status === BillingProductStatus.ARCHIVED) {
        throw billingProductConflict(
          "Archived commerce products cannot be edited.",
        );
      }

      const nextSortOrder = product.sortOrder ?? current.sortOrder;
      const nextIsRecommended =
        product.isRecommended ?? current.isRecommended;

      const changedFields = [
        current.name !== product.name ? "name" : null,
        current.description !== product.description ? "description" : null,
        current.sortOrder !== nextSortOrder ? "sortOrder" : null,
        current.isRecommended !== nextIsRecommended
          ? "isRecommended"
          : null,
      ].filter((value): value is string => Boolean(value));
      const resultingRevision = changedFields.length
        ? current.revision + 1
        : current.revision;
      if (changedFields.length) {
        const updated = await tx.billingProduct.updateMany({
          where: {
            id: productId,
            representativeId: representative.id,
            revision: product.expectedRevision,
          },
          data: {
            name: product.name,
            description: product.description,
            sortOrder: nextSortOrder,
            isRecommended: nextIsRecommended,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw billingProductRevisionConflict();
      }

      await createBillingAudit(tx, {
        metadata,
        representativeId: representative.id,
        type: EventType.BILLING_PRODUCT_UPDATED,
        requestHash,
        payload: {
          operation: "update_product",
          productId,
          changedFields,
          outcome: changedFields.length ? "updated" : "no_change",
          expectedRevision: product.expectedRevision,
          resultingRevision,
        },
      });
      return loadScopedBillingProduct(tx, representative.id, productId);
    },
  });
}

export async function publishOwnerBillingPriceVersion(
  input: OwnerBillingMutationMetadata & {
    productId: string;
    priceVersion: unknown;
  },
  client: PrismaClient = prisma,
): Promise<OwnerBillingProduct> {
  const metadata = normalizeMutationMetadata(input);
  const productId = requireRequestToken(input.productId, "productId");
  const priceVersion = parseMutation(
    publishPriceInputSchema,
    input.priceVersion,
  );
  const requestHash = hashBillingRequest("publish_price_version", {
    representativeSlug: metadata.representativeSlug,
    productId,
    ...priceVersion,
  });

  return executeBillingMutation({
    client,
    metadata,
    expectedType: EventType.BILLING_PRICE_VERSION_PUBLISHED,
    requestHash,
    operation: async (tx) => {
      const replay = await findBillingReplay(
        tx,
        metadata,
        EventType.BILLING_PRICE_VERSION_PUBLISHED,
        requestHash,
      );
      if (replay) {
        return loadScopedBillingProduct(
          tx,
          replay.representativeId,
          replay.productId,
        );
      }

      const representative = await findScopedRepresentative(tx, metadata);
      await lockScopedBillingProduct(
        tx,
        representative.id,
        productId,
      );
      const current = await loadScopedBillingProductRecord(
        tx,
        representative.id,
        productId,
      );
      assertExpectedRevision(current, priceVersion.expectedRevision);
      if (current.status !== BillingProductStatus.ACTIVE) {
        throw billingProductConflict(
          "Only active commerce products can publish a new price.",
        );
      }
      const activePrice = current.priceVersions.find(
        (version) => version.status === BillingPriceVersionStatus.ACTIVE,
      );
      if (
        !activePrice
        || activePrice.id !== priceVersion.expectedActivePriceVersionId
      ) {
        throw billingProductConflict(
          "The active price changed. Refresh the service package and review the new terms.",
        );
      }

      const nextVersion =
        Math.max(0, ...current.priceVersions.map((version) => version.version))
        + 1;
      const now = new Date();
      const commercialTerms = commercialPriceData(
        current.kind,
        priceVersion.price,
        resolveRepresentativeRevenueShareBps(representative),
      );
      assertProductCanBePublished(
        representative,
        current.kind,
        commercialTerms.handoffAllowance,
      );
      const nextPrice = await tx.billingPriceVersion.create({
        data: {
          billingProductId: productId,
          version: nextVersion,
          status: BillingPriceVersionStatus.DRAFT,
          ...commercialTerms,
        },
        select: { id: true },
      });
      const retired = await tx.billingPriceVersion.updateMany({
        where: {
          id: activePrice.id,
          billingProductId: productId,
          status: BillingPriceVersionStatus.ACTIVE,
        },
        data: {
          status: BillingPriceVersionStatus.RETIRED,
          retiredAt: now,
        },
      });
      if (retired.count !== 1) {
        throw billingProductConflict(
          "The active price changed. Refresh and try again.",
        );
      }
      await tx.billingPriceVersion.update({
        where: { id: nextPrice.id },
        data: {
          status: BillingPriceVersionStatus.ACTIVE,
          publishedAt: now,
        },
      });
      const updated = await tx.billingProduct.updateMany({
        where: {
          id: productId,
          representativeId: representative.id,
          revision: priceVersion.expectedRevision,
          status: BillingProductStatus.ACTIVE,
        },
        data: {
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw billingProductRevisionConflict();

      await createBillingAudit(tx, {
        metadata,
        representativeId: representative.id,
        type: EventType.BILLING_PRICE_VERSION_PUBLISHED,
        requestHash,
        payload: {
          operation: "publish_price_version",
          productId,
          productKind: current.kind,
          previousPriceVersionId: activePrice.id,
          priceVersionId: nextPrice.id,
          version: nextVersion,
          expectedRevision: priceVersion.expectedRevision,
          resultingRevision: priceVersion.expectedRevision + 1,
        },
      });
      return loadScopedBillingProduct(tx, representative.id, productId);
    },
  });
}

export async function archiveOwnerBillingProduct(
  input: OwnerBillingMutationMetadata & {
    productId: string;
    archive: unknown;
  },
  client: PrismaClient = prisma,
): Promise<OwnerBillingProduct> {
  const metadata = normalizeMutationMetadata(input);
  const productId = requireRequestToken(input.productId, "productId");
  const archive = parseMutation(archiveProductInputSchema, input.archive);
  const requestHash = hashBillingRequest("archive_product", {
    representativeSlug: metadata.representativeSlug,
    productId,
    ...archive,
  });

  return executeBillingMutation({
    client,
    metadata,
    expectedType: EventType.BILLING_PRODUCT_ARCHIVED,
    requestHash,
    operation: async (tx) => {
      const replay = await findBillingReplay(
        tx,
        metadata,
        EventType.BILLING_PRODUCT_ARCHIVED,
        requestHash,
      );
      if (replay) {
        return loadScopedBillingProduct(
          tx,
          replay.representativeId,
          replay.productId,
        );
      }

      const representative = await findScopedRepresentative(tx, metadata);
      await lockScopedBillingProduct(
        tx,
        representative.id,
        productId,
      );
      const current = await loadScopedBillingProductRecord(
        tx,
        representative.id,
        productId,
      );
      assertExpectedRevision(current, archive.expectedRevision);
      if (current.status === BillingProductStatus.ARCHIVED) {
        throw billingProductConflict(
          "This commerce product is already archived.",
        );
      }

      const now = new Date();
      const activePrice = current.priceVersions.find(
        (version) => version.status === BillingPriceVersionStatus.ACTIVE,
      );
      if (activePrice) {
        const retired = await tx.billingPriceVersion.updateMany({
          where: {
            id: activePrice.id,
            billingProductId: productId,
            status: BillingPriceVersionStatus.ACTIVE,
          },
          data: {
            status: BillingPriceVersionStatus.RETIRED,
            retiredAt: now,
          },
        });
        if (retired.count !== 1) {
          throw billingProductConflict(
            "The active price changed. Refresh and try again.",
          );
        }
      }
      const archived = await tx.billingProduct.updateMany({
        where: {
          id: productId,
          representativeId: representative.id,
          revision: archive.expectedRevision,
          status: {
            in: [BillingProductStatus.DRAFT, BillingProductStatus.ACTIVE],
          },
        },
        data: {
          status: BillingProductStatus.ARCHIVED,
          revision: { increment: 1 },
        },
      });
      if (archived.count !== 1) throw billingProductRevisionConflict();

      await createBillingAudit(tx, {
        metadata,
        representativeId: representative.id,
        type: EventType.BILLING_PRODUCT_ARCHIVED,
        requestHash,
        payload: {
          operation: "archive_product",
          productId,
          previousPriceVersionId: activePrice?.id ?? null,
          expectedRevision: archive.expectedRevision,
          resultingRevision: archive.expectedRevision + 1,
          status: "ARCHIVED",
        },
      });
      return loadScopedBillingProduct(tx, representative.id, productId);
    },
  });
}

export async function updateOwnerRepresentativeCommerceSettings(
  input: OwnerBillingMutationMetadata & {
    settings: unknown;
  },
  client: PrismaClient = prisma,
): Promise<OwnerRepresentativeCommerceSettings> {
  const metadata = normalizeMutationMetadata(input);
  const settings = parseMutation(
    commerceSettingsInputSchema,
    input.settings,
  );
  const requestHash = hashBillingRequest("update_commerce_settings", {
    representativeSlug: metadata.representativeSlug,
    settings,
  });

  const operation = async (tx: Prisma.TransactionClient) => {
    const replay = await tx.eventAudit.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: metadata.ownerId,
          idempotencyKey: metadata.idempotencyKey,
        },
      },
      select: {
        type: true,
        requestHash: true,
        representativeId: true,
      },
    });
    if (replay) {
      if (
        replay.type !== EventType.REPRESENTATIVE_COMMERCE_UPDATED
        || replay.requestHash !== requestHash
        || !replay.representativeId
      ) {
        throw billingProductIdempotencyConflict();
      }
      return loadOwnerCommerceSettings(
        tx,
        metadata.ownerId,
        metadata.representativeSlug,
      );
    }

    const representative = await findScopedRepresentative(tx, metadata);
    await lockScopedRepresentative(tx, representative.id);
    const current = await findScopedRepresentative(tx, metadata);
    const nextAccessMode = settings.accessMode ?? current.accessMode;
    const nextTipsEnabled = settings.tipsEnabled ?? current.tipsEnabled;
    const nextSettings = {
      accessMode: nextAccessMode,
      handoffAccessMode:
        settings.handoffAccessMode ?? current.handoffAccessMode,
      tipsEnabled: nextTipsEnabled,
      freeReplyLimit: settings.freeReplyLimit ?? current.freeReplyLimit,
      humanInLoop: settings.humanInLoop ?? current.humanInLoop,
    };

    if (
      settings.accessMode === RepresentativeAccessMode.FREE
      && current.accessMode !== RepresentativeAccessMode.FREE
    ) {
      const activeServicePackages = await tx.billingProduct.count({
        where: {
          representativeId: current.id,
          kind: BillingProductKind.SERVICE_PACKAGE,
          status: BillingProductStatus.ACTIVE,
        },
      });
      if (activeServicePackages > 0) {
        throw billingProductConflict(
          "Archive every active service package before switching to free access.",
        );
      }
    }
    if (settings.tipsEnabled === false && current.tipsEnabled) {
      const activeTips = await tx.billingProduct.count({
        where: {
          representativeId: current.id,
          kind: BillingProductKind.TIP,
          status: BillingProductStatus.ACTIVE,
        },
      });
      if (activeTips > 0) {
        throw billingProductConflict(
          "Archive every active tip option before disabling tips.",
        );
      }
    }
    const currentlyHonorsPaidHandoff =
      current.humanInLoop
      && current.handoffAccessMode
        === RepresentativeHandoffAccessMode.PACKAGE_REQUIRED;
    const willHonorPaidHandoff =
      nextSettings.humanInLoop
      && nextSettings.handoffAccessMode
        === RepresentativeHandoffAccessMode.PACKAGE_REQUIRED;
    if (currentlyHonorsPaidHandoff && !willHonorPaidHandoff) {
      const now = new Date();
      const [activeHandoffPrices, outstandingGrants, activePaidRequests] =
        await Promise.all([
          tx.billingPriceVersion.count({
            where: {
              status: BillingPriceVersionStatus.ACTIVE,
              handoffAllowance: { not: BillingHandoffAllowance.NONE },
              billingProduct: {
                representativeId: current.id,
                kind: BillingProductKind.SERVICE_PACKAGE,
                status: BillingProductStatus.ACTIVE,
              },
            },
          }),
          tx.handoffEntitlementGrant.count({
            where: {
              representativeId: current.id,
              status: {
                in: [
                  "ACTIVE",
                  "FROZEN",
                ],
              },
              OR: [
                { expiresAt: { gt: now } },
                { reservedUses: { gt: 0 } },
              ],
            },
          }),
          tx.handoffRequest.count({
            where: {
              representativeId: current.id,
              handoffEntitlementGrantId: { not: null },
              status: { in: ["OPEN", "REVIEWING", "ACCEPTED"] },
            },
          }),
        ]);
      if (
        activeHandoffPrices > 0
        || outstandingGrants > 0
        || activePaidRequests > 0
      ) {
        throw billingProductConflict(
          "Paid handoff cannot be disabled while a handoff package is on sale or purchased handoff obligations remain active.",
        );
      }
    }
    const changedFields = Object.entries(nextSettings)
      .filter(([field, value]) => current[field as keyof typeof nextSettings] !== value)
      .map(([field]) => field);

    if (changedFields.length > 0) {
      await tx.representative.update({
        where: { id: current.id },
        data: nextSettings,
      });
    }
    await createBillingAudit(tx, {
      metadata,
      representativeId: current.id,
      type: EventType.REPRESENTATIVE_COMMERCE_UPDATED,
      requestHash,
      payload: {
        operation: "update_commerce_settings",
        changedFields,
        outcome: changedFields.length > 0 ? "updated" : "no_change",
        settings: nextSettings,
      },
    });
    return loadOwnerCommerceSettings(
      tx,
      metadata.ownerId,
      metadata.representativeSlug,
    );
  };

  try {
    return await runSerializableBillingTransaction(client, operation);
  } catch (error) {
    if (error instanceof OwnerBillingProductError) throw error;
    if (prismaErrorCode(error) !== "P2002") throw error;
    const replay = await client.eventAudit.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: metadata.ownerId,
          idempotencyKey: metadata.idempotencyKey,
        },
      },
      select: { type: true, requestHash: true, representativeId: true },
    });
    if (
      replay?.type === EventType.REPRESENTATIVE_COMMERCE_UPDATED
      && replay.requestHash === requestHash
      && replay.representativeId
    ) {
      return loadOwnerCommerceSettings(
        client,
        metadata.ownerId,
        metadata.representativeSlug,
      );
    }
    throw billingProductIdempotencyConflict();
  }
}

function commercialPriceData(
  kind: "SERVICE_PACKAGE" | "TIP",
  price: z.infer<typeof priceInputSchema>,
  creatorRevenueShareBps: number,
) {
  const shared = {
    currency: "CNY" as const,
    amountMinor: price.amountMinor,
    creatorRevenueShareBps,
    platformRevenueShareBps: 10_000 - creatorRevenueShareBps,
    expiryPolicy: BillingEntitlementExpiryPolicy.NEVER_EXPIRES,
    entitlementValidityDays: null,
  };
  if (kind === "TIP") {
    if (
      price.entitlementUnits !== undefined
      && price.entitlementUnits !== 0
    ) {
      throw invalidCommercialTerms(
        "Tips cannot grant service credits.",
        "entitlementUnits",
      );
    }
    if (
      (price.handoffAllowance ?? "NONE") !== "NONE"
      || price.handoffUnits != null
      || price.handoffServiceLevel != null
      || price.handoffValidityDays != null
    ) {
      throw invalidCommercialTerms(
        "Tips cannot grant human-handoff access.",
        "handoffAllowance",
      );
    }
    return {
      ...shared,
      unitName: "tip" as const,
      entitlementUnits: 0,
      refundPolicy: BillingRefundPolicy.NON_REFUNDABLE,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    };
  }

  if (!price.entitlementUnits || price.entitlementUnits <= 0) {
    throw invalidCommercialTerms(
      "Service packages must grant at least one service credit.",
      "entitlementUnits",
    );
  }
  const allowance = price.handoffAllowance ?? "NONE";
  if (allowance === "NONE") {
    if (
      price.handoffUnits != null
      || price.handoffServiceLevel != null
      || price.handoffValidityDays != null
    ) {
      throw invalidCommercialTerms(
        "A package without handoff access cannot include handoff terms.",
        "handoffAllowance",
      );
    }
    return {
      ...shared,
      unitName: "credit" as const,
      entitlementUnits: price.entitlementUnits,
      refundPolicy: BillingRefundPolicy.FULL_WHEN_UNUSED,
      handoffAllowance: BillingHandoffAllowance.NONE,
      handoffUnits: null,
      handoffServiceLevel: null,
      handoffValidityDays: null,
    };
  }
  if (!price.handoffServiceLevel || !price.handoffValidityDays) {
    throw invalidCommercialTerms(
      "Handoff packages require a service level and validity period.",
      "handoffServiceLevel",
    );
  }
  if (allowance === "LIMITED" && !price.handoffUnits) {
    throw invalidCommercialTerms(
      "Limited handoff packages require at least one handoff use.",
      "handoffUnits",
    );
  }
  if (allowance === "UNLIMITED" && price.handoffUnits != null) {
    throw invalidCommercialTerms(
      "Unlimited handoff packages cannot set a handoff-use count.",
      "handoffUnits",
    );
  }
  return {
    ...shared,
    unitName: "credit" as const,
    entitlementUnits: price.entitlementUnits,
    refundPolicy: BillingRefundPolicy.FULL_WHEN_UNUSED,
    handoffAllowance:
      allowance === "LIMITED"
        ? BillingHandoffAllowance.LIMITED
        : BillingHandoffAllowance.UNLIMITED,
    handoffUnits: allowance === "LIMITED" ? price.handoffUnits! : null,
    handoffServiceLevel:
      price.handoffServiceLevel === "PRIORITY"
        ? BillingHandoffServiceLevel.PRIORITY
        : BillingHandoffServiceLevel.STANDARD,
    handoffValidityDays: price.handoffValidityDays,
  };
}

function invalidCommercialTerms(message: string, field: string) {
  return new OwnerBillingProductError(
    "billing_product_invalid",
    message,
    400,
    { [field]: [message] },
  );
}

async function executeBillingMutation(input: {
  client: PrismaClient;
  metadata: OwnerBillingMutationMetadata;
  expectedType: EventType;
  requestHash: string;
  operation: (
    tx: Prisma.TransactionClient,
  ) => Promise<OwnerBillingProduct>;
}): Promise<OwnerBillingProduct> {
  try {
    return await runSerializableBillingTransaction(
      input.client,
      input.operation,
    );
  } catch (error) {
    if (error instanceof OwnerBillingProductError) throw error;
    if (prismaErrorCode(error) !== "P2002") throw error;

    const replay = await input.client.eventAudit.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: input.metadata.ownerId,
          idempotencyKey: input.metadata.idempotencyKey,
        },
      },
      select: {
        type: true,
        requestHash: true,
        representativeId: true,
        payload: true,
      },
    });
    if (
      replay
      && replay.type === input.expectedType
      && replay.requestHash === input.requestHash
      && replay.representativeId
    ) {
      const productId = readProductId(replay.payload);
      if (productId) {
        return loadScopedBillingProduct(
          input.client as unknown as BillingReadClient,
          replay.representativeId,
          productId,
        );
      }
    }
    if (replay) throw billingProductIdempotencyConflict();
    throw billingProductConflict(
      "The billing catalog changed concurrently. Refresh and try again.",
    );
  }
}

async function runSerializableBillingTransaction<T>(
  client: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= maximumSerializableAttempts;
    attempt += 1
  ) {
    try {
      return await client.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (prismaErrorCode(error) !== "P2034") throw error;
      if (attempt === maximumSerializableAttempts) {
        throw billingProductConflict(
          "The billing catalog changed concurrently. Refresh and try again.",
        );
      }
    }
  }
  throw billingProductConflict(
    "The billing catalog changed concurrently. Refresh and try again.",
  );
}

async function findScopedRepresentative(
  client: BillingReadClient,
  metadata: OwnerBillingMutationMetadata,
) {
  const representative = await client.representative.findFirst({
    where: {
      ownerId: metadata.ownerId,
      slug: metadata.representativeSlug,
    },
    select: {
      id: true,
      slug: true,
      accessMode: true,
      handoffAccessMode: true,
      tipsEnabled: true,
      freeReplyLimit: true,
      humanInLoop: true,
      agentWallet: {
        select: {
          currency: true,
          creatorRevenueShareBps: true,
        },
      },
    },
  });
  if (!representative) throw billingProductNotFound();
  return representative;
}

async function loadOwnerCommerceSettings(
  client: Pick<Prisma.TransactionClient, "representative">,
  ownerId: string,
  representativeSlug: string,
): Promise<OwnerRepresentativeCommerceSettings> {
  const representative = await client.representative.findFirst({
    where: { ownerId, slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      accessMode: true,
      handoffAccessMode: true,
      tipsEnabled: true,
      freeReplyLimit: true,
      humanInLoop: true,
    },
  });
  if (!representative) throw billingProductNotFound();
  return {
    id: representative.id,
    slug: representative.slug,
    name: representative.displayName,
    accessMode: representative.accessMode,
    handoffAccessMode: representative.handoffAccessMode,
    tipsEnabled: representative.tipsEnabled,
    freeReplyLimit: representative.freeReplyLimit,
    humanInLoop: representative.humanInLoop,
  };
}

async function lockScopedRepresentative(
  tx: Prisma.TransactionClient,
  representativeId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Representative"
    WHERE "id" = ${representativeId}
    FOR UPDATE
  `);
  if (rows.length !== 1) throw billingProductNotFound();
}

function assertProductCanBePublished(
  representative: {
    accessMode: RepresentativeAccessMode;
    tipsEnabled: boolean;
    humanInLoop: boolean;
    handoffAccessMode: RepresentativeHandoffAccessMode;
  },
  kind: BillingProductKind,
  handoffAllowance: BillingHandoffAllowance,
) {
  if (
    kind === BillingProductKind.SERVICE_PACKAGE
    && representative.accessMode === RepresentativeAccessMode.FREE
  ) {
    throw billingProductConflict(
      "Free representatives cannot publish an active service package.",
    );
  }
  if (kind === BillingProductKind.TIP && !representative.tipsEnabled) {
    throw billingProductConflict(
      "Enable tips before publishing an active tip option.",
    );
  }
  if (
    kind === BillingProductKind.SERVICE_PACKAGE
    && handoffAllowance !== BillingHandoffAllowance.NONE
    && (
      !representative.humanInLoop
      || representative.handoffAccessMode
        !== RepresentativeHandoffAccessMode.PACKAGE_REQUIRED
    )
  ) {
    throw billingProductConflict(
      "Enable package-required human handoff before publishing paid handoff uses or priority.",
    );
  }
}

function resolveRepresentativeRevenueShareBps(
  representative: {
    agentWallet: {
      currency: string;
      creatorRevenueShareBps: number;
    } | null;
  },
) {
  if (!representative.agentWallet || representative.agentWallet.currency !== "CNY") {
    throw billingProductConflict(
      "The representative CNY billing policy is unavailable.",
    );
  }
  try {
    return normalizeCreatorRevenueShareBps(
      representative.agentWallet.creatorRevenueShareBps,
    );
  } catch {
    throw billingProductConflict(
      "The representative revenue-share policy is invalid.",
    );
  }
}

function serializeRepresentativeRevenueSharePolicy(
  representative: {
    agentWallet: {
      currency: string;
      creatorRevenueShareBps: number;
    } | null;
  },
): OwnerBillingCatalog["revenueSharePolicy"] {
  if (!representative.agentWallet || representative.agentWallet.currency !== "CNY") {
    return null;
  }
  try {
    const creatorRevenueShareBps = normalizeCreatorRevenueShareBps(
      representative.agentWallet.creatorRevenueShareBps,
    );
    return {
      currency: "CNY",
      creatorRevenueShareBps,
      platformRevenueShareBps: 10_000 - creatorRevenueShareBps,
    };
  } catch {
    return null;
  }
}

async function lockScopedBillingProduct(
  tx: Prisma.TransactionClient,
  representativeId: string,
  productId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "BillingProduct"
    WHERE
      "id" = ${productId}
      AND "representativeId" = ${representativeId}
    FOR UPDATE
  `);
  if (rows.length !== 1) throw billingProductNotFound();
}

async function loadScopedBillingProductRecord(
  client: BillingReadClient,
  representativeId: string,
  productId: string,
): Promise<BillingProductRecord> {
  const product = await client.billingProduct.findFirst({
    where: {
      id: productId,
      representativeId,
    },
    select: billingProductSelect,
  });
  if (!product) throw billingProductNotFound();
  return product;
}

async function loadScopedBillingProduct(
  client: BillingReadClient,
  representativeId: string,
  productId: string,
): Promise<OwnerBillingProduct> {
  return serializeBillingProduct(
    await loadScopedBillingProductRecord(
      client,
      representativeId,
      productId,
    ),
  );
}

async function findBillingReplay(
  client: BillingReadClient,
  metadata: OwnerBillingMutationMetadata,
  expectedType: EventType,
  requestHash: string,
): Promise<{
  representativeId: string;
  productId: string;
} | null> {
  const replay = await client.eventAudit.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId: metadata.ownerId,
        idempotencyKey: metadata.idempotencyKey,
      },
    },
    select: {
      type: true,
      requestHash: true,
      representativeId: true,
      payload: true,
    },
  });
  if (!replay) return null;
  if (
    replay.type !== expectedType
    || replay.requestHash !== requestHash
    || !replay.representativeId
  ) {
    throw billingProductIdempotencyConflict();
  }
  const productId = readProductId(replay.payload);
  if (!productId) throw billingProductIdempotencyConflict();
  return {
    representativeId: replay.representativeId,
    productId,
  };
}

async function createBillingAudit(
  tx: Prisma.TransactionClient,
  input: {
    metadata: OwnerBillingMutationMetadata;
    representativeId: string;
    type: EventType;
    requestHash: string;
    payload: Record<string, unknown>;
  },
) {
  await tx.eventAudit.create({
    data: {
      ownerId: input.metadata.ownerId,
      representativeId: input.representativeId,
      type: input.type,
      idempotencyKey: input.metadata.idempotencyKey,
      requestHash: input.requestHash,
      payload: {
        actorId: input.metadata.ownerId,
        requestId: input.metadata.requestId,
        representativeSlug: input.metadata.representativeSlug,
        resourceId: input.payload.productId ?? input.representativeId,
        ...input.payload,
      } as Prisma.InputJsonValue,
    },
  });
}

function serializeBillingProduct(
  product: BillingProductRecord,
): OwnerBillingProduct {
  const priceVersions = product.priceVersions.map(
    serializeBillingPriceVersion,
  );
  return {
    id: product.id,
    representativeId: product.representativeId,
    code: product.code,
    name: product.name,
    description: product.description,
    kind: product.kind ?? "SERVICE_PACKAGE",
    sortOrder: product.sortOrder ?? 0,
    isRecommended: product.isRecommended ?? false,
    status: product.status,
    revision: product.revision,
    activePriceVersion:
      priceVersions.find((version) => version.status === "ACTIVE") ?? null,
    priceVersions,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function serializeBillingPriceVersion(
  version: BillingProductRecord["priceVersions"][number],
): OwnerBillingPriceVersion {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    currency: "CNY",
    amountMinor: version.amountMinor,
    unitName: version.unitName as "credit" | "tip",
    entitlementUnits: version.entitlementUnits,
    creatorRevenueShareBps: version.creatorRevenueShareBps,
    platformRevenueShareBps: version.platformRevenueShareBps,
    refundPolicy: version.refundPolicy,
    expiryPolicy: "NEVER_EXPIRES",
    entitlementValidityDays: null,
    handoffAllowance: version.handoffAllowance ?? "NONE",
    handoffUnits: version.handoffUnits ?? null,
    handoffServiceLevel: version.handoffServiceLevel ?? null,
    handoffValidityDays: version.handoffValidityDays ?? null,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    retiredAt: version.retiredAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}

function assertExpectedRevision(
  product: Pick<BillingProductRecord, "revision">,
  expectedRevision: number,
) {
  if (product.revision !== expectedRevision) {
    throw billingProductRevisionConflict();
  }
}

function normalizeMutationMetadata(
  input: OwnerBillingMutationMetadata,
): OwnerBillingMutationMetadata {
  return {
    ownerId: requireRequestToken(input.ownerId, "ownerId"),
    representativeSlug: requireRequestToken(
      input.representativeSlug,
      "representativeSlug",
    ),
    requestId: requireRequestToken(input.requestId, "requestId"),
    idempotencyKey: requireRequestToken(
      input.idempotencyKey,
      "idempotencyKey",
    ),
  };
}

function requireRequestToken(value: string, field: string) {
  const normalized = value?.trim();
  if (
    !normalized
    || normalized.length > maximumRequestTokenLength
    || normalized.includes("\0")
  ) {
    throw new OwnerBillingProductError(
      "billing_product_invalid",
      `${field} is required and must not exceed ${maximumRequestTokenLength} characters.`,
      400,
      { [field]: ["Invalid value."] },
    );
  }
  return normalized;
}

function parseMutation<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const field = [...issue.path]
      .reverse()
      .find((segment): segment is string => typeof segment === "string");
    if (!field) continue;
    const messages = fieldErrors[field] ?? [];
    if (!messages.includes(issue.message)) messages.push(issue.message);
    fieldErrors[field] = messages;
  }
  throw new OwnerBillingProductError(
    "billing_product_invalid",
    "The service package request is invalid.",
    400,
    fieldErrors,
  );
}

function hashBillingRequest(
  operation: string,
  value: unknown,
) {
  return createHash("sha256")
    .update(JSON.stringify({ operation, value }))
    .digest("hex");
}

function readProductId(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const productId = (payload as Record<string, unknown>).productId;
  return typeof productId === "string" && productId.trim()
    ? productId
    : null;
}

function billingProductNotFound() {
  return new OwnerBillingProductError(
    "billing_product_not_found",
    "The service package was not found.",
    404,
  );
}

function billingProductConflict(message: string) {
  return new OwnerBillingProductError(
    "billing_product_conflict",
    message,
    409,
  );
}

function billingProductRevisionConflict() {
  return billingProductConflict(
    "The service package changed. Refresh it before saving.",
  );
}

function billingProductIdempotencyConflict() {
  return new OwnerBillingProductError(
    "billing_product_idempotency_conflict",
    "This idempotency key belongs to a different billing request.",
    409,
  );
}

function prismaErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}
