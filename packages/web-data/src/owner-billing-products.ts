import { createHash, randomUUID } from "node:crypto";

import {
  BillingEntitlementExpiryPolicy,
  BillingPriceVersionStatus,
  BillingProductStatus,
  BillingRefundPolicy,
  EventType,
  Prisma,
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
    entitlementUnits: z.number().int().min(1).max(10_000_000),
  })
  .strict()
  .superRefine((price, context) => {
    if (price.amountMinor % price.entitlementUnits !== 0) {
      context.addIssue({
        code: "custom",
        path: ["entitlementUnits"],
        message:
          "The CNY amount must divide evenly into the included service credits.",
      });
    }
  });

const createProductInputSchema = z
  .object({
    name: z.string().trim().min(1).max(maximumProductNameLength),
    description: z
      .string()
      .trim()
      .max(maximumProductDescriptionLength)
      .nullable()
      .optional(),
    price: priceInputSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    description: input.description?.trim() || null,
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
  unitName: "credit";
  entitlementUnits: number;
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  refundPolicy: "FULL_WHEN_UNUSED";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
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
  };
  revenueSharePolicy: {
    currency: "CNY";
    creatorRevenueShareBps: number;
    platformRevenueShareBps: number;
  } | null;
  products: OwnerBillingProduct[];
};

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
      const now = new Date();
      const createdProduct = await tx.billingProduct.create({
        data: {
          representativeId: representative.id,
          code: `service-package-${randomUUID()}`,
          name: product.name,
          description: product.description,
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
          ...commercialPriceData(
            product.price,
            resolveRepresentativeRevenueShareBps(representative),
          ),
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
          "Archived service packages cannot be edited.",
        );
      }

      const changedFields = [
        current.name !== product.name ? "name" : null,
        current.description !== product.description ? "description" : null,
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
          "Only active service packages can publish a new price.",
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
      const nextPrice = await tx.billingPriceVersion.create({
        data: {
          billingProductId: productId,
          version: nextVersion,
          status: BillingPriceVersionStatus.DRAFT,
          ...commercialPriceData(
            priceVersion.price,
            resolveRepresentativeRevenueShareBps(representative),
          ),
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
          "This service package is already archived.",
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

function commercialPriceData(
  price: z.infer<typeof priceInputSchema>,
  creatorRevenueShareBps: number,
) {
  return {
    currency: "CNY",
    amountMinor: price.amountMinor,
    unitName: "credit",
    entitlementUnits: price.entitlementUnits,
    creatorRevenueShareBps,
    platformRevenueShareBps: 10_000 - creatorRevenueShareBps,
    refundPolicy: BillingRefundPolicy.FULL_WHEN_UNUSED,
    expiryPolicy: BillingEntitlementExpiryPolicy.NEVER_EXPIRES,
    entitlementValidityDays: null,
  } as const;
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
        resourceId: input.payload.productId,
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
    unitName: "credit",
    entitlementUnits: version.entitlementUnits,
    creatorRevenueShareBps: version.creatorRevenueShareBps,
    platformRevenueShareBps: version.platformRevenueShareBps,
    refundPolicy: "FULL_WHEN_UNUSED",
    expiryPolicy: "NEVER_EXPIRES",
    entitlementValidityDays: null,
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
  const flattenedFieldErrors = z.flattenError(parsed.error).fieldErrors;
  const fieldErrors: Record<string, string[]> = {};
  for (
    const [field, messages] of Object.entries(flattenedFieldErrors) as Array<
      [string, string[] | undefined]
    >
  ) {
    if (messages) fieldErrors[field] = messages;
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
