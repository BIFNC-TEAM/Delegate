import {
  BillingPriceVersionStatus,
  BillingProductStatus,
  EventType,
  type PrismaClient,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  OwnerBillingProductError,
  archiveOwnerBillingProduct,
  createAndPublishOwnerBillingProduct,
  getOwnerRepresentativeBillingCatalog,
  publishOwnerBillingPriceVersion,
  updateOwnerBillingProduct,
} from "../src/owner-billing-products";

describe("owner billing products", () => {
  it("creates and publishes one immutable CNY package with an audit event", async () => {
    const client = new MemoryOwnerBillingClient();

    const product = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "create-package-1",
        product: {
          name: "标准服务包",
          description: "当前代表专属",
          price: {
            amountMinor: 2_000,
            entitlementUnits: 1_000,
          },
        },
      }),
      client.asPrisma(),
    );

    expect(product).toMatchObject({
      name: "标准服务包",
      description: "当前代表专属",
      status: "ACTIVE",
      revision: 1,
      activePriceVersion: {
        version: 1,
        status: "ACTIVE",
        currency: "CNY",
        amountMinor: 2_000,
        unitName: "credit",
        entitlementUnits: 1_000,
        creatorRevenueShareBps: 2_000,
        platformRevenueShareBps: 8_000,
        refundPolicy: "FULL_WHEN_UNUSED",
        expiryPolicy: "NEVER_EXPIRES",
      },
    });
    expect(client.audits).toHaveLength(1);
    expect(client.audits[0]).toMatchObject({
      ownerId: "owner-1",
      representativeId: "rep-1",
      type: EventType.BILLING_PRODUCT_CREATED,
      idempotencyKey: "create-package-1",
    });

    await expect(
      getOwnerRepresentativeBillingCatalog(
        {
          ownerId: "owner-1",
          representativeSlug: "delegate",
        },
        client.asPrisma(),
      ),
    ).resolves.toMatchObject({
      representative: {
        id: "rep-1",
        slug: "delegate",
      },
      revenueSharePolicy: {
        currency: "CNY",
        creatorRevenueShareBps: 2_000,
        platformRevenueShareBps: 8_000,
      },
      products: [{ id: product.id, revision: 1 }],
    });
  });

  it("replays an identical create and rejects a changed request using the same key", async () => {
    const client = new MemoryOwnerBillingClient();
    const input = mutationInput({
      idempotencyKey: "create-replay",
      product: packageInput(),
    });

    const first = await createAndPublishOwnerBillingProduct(
      input,
      client.asPrisma(),
    );
    const replay = await createAndPublishOwnerBillingProduct(
      input,
      client.asPrisma(),
    );

    expect(replay.id).toBe(first.id);
    expect(client.products).toHaveLength(1);
    expect(client.prices).toHaveLength(1);
    expect(client.audits).toHaveLength(1);

    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "create-replay",
          product: {
            ...packageInput(),
            name: "Changed package",
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_idempotency_conflict",
      statusCode: 409,
    });

    await expect(
      createAndPublishOwnerBillingProduct(
        {
          ...input,
          representativeSlug: "second-representative",
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_idempotency_conflict",
      statusCode: 409,
    });
  });

  it("publishes a replacement atomically and rejects stale revisions", async () => {
    const client = new MemoryOwnerBillingClient();
    const created = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "publish-create",
        product: packageInput(),
      }),
      client.asPrisma(),
    );
    const previousPrice = created.activePriceVersion!;

    const published = await publishOwnerBillingPriceVersion(
      {
        ...metadata("publish-v2"),
        productId: created.id,
        priceVersion: {
          expectedRevision: created.revision,
          expectedActivePriceVersionId: previousPrice.id,
          price: {
            amountMinor: 4_000,
            entitlementUnits: 2_000,
          },
        },
      },
      client.asPrisma(),
    );

    expect(published).toMatchObject({
      revision: 2,
      activePriceVersion: {
        version: 2,
        amountMinor: 4_000,
        entitlementUnits: 2_000,
        creatorRevenueShareBps: 2_000,
        platformRevenueShareBps: 8_000,
      },
    });
    expect(
      published.priceVersions.find(
        (version) => version.id === previousPrice.id,
      ),
    ).toMatchObject({
      status: "RETIRED",
      retiredAt: expect.any(String),
    });
    expect(
      published.priceVersions.filter(
        (version) => version.status === "ACTIVE",
      ),
    ).toHaveLength(1);

    await expect(
      publishOwnerBillingPriceVersion(
        {
          ...metadata("publish-stale"),
          productId: created.id,
          priceVersion: {
            expectedRevision: 1,
            expectedActivePriceVersionId: previousPrice.id,
            price: {
              amountMinor: 6_000,
              entitlementUnits: 3_000,
            },
          },
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_conflict",
      statusCode: 409,
    });
  });

  it("updates metadata with CAS and archives the product with its active price", async () => {
    const client = new MemoryOwnerBillingClient();
    const created = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "archive-create",
        product: packageInput(),
      }),
      client.asPrisma(),
    );

    const renamed = await updateOwnerBillingProduct(
      {
        ...metadata("rename-package"),
        productId: created.id,
        product: {
          expectedRevision: created.revision,
          name: "专业服务包",
          description: "新的公开说明",
        },
      },
      client.asPrisma(),
    );
    expect(renamed).toMatchObject({
      name: "专业服务包",
      revision: 2,
    });

    const archived = await archiveOwnerBillingProduct(
      {
        ...metadata("archive-package"),
        productId: renamed.id,
        archive: { expectedRevision: renamed.revision },
      },
      client.asPrisma(),
    );
    expect(archived).toMatchObject({
      status: "ARCHIVED",
      revision: 3,
      activePriceVersion: null,
    });
    expect(archived.priceVersions[0]).toMatchObject({
      status: "RETIRED",
      retiredAt: expect.any(String),
    });
    expect(client.audits.map((event) => event.type)).toEqual([
      EventType.BILLING_PRODUCT_CREATED,
      EventType.BILLING_PRODUCT_UPDATED,
      EventType.BILLING_PRODUCT_ARCHIVED,
    ]);
  });

  it("fails closed for invalid package precision and cross-owner scope", async () => {
    const client = new MemoryOwnerBillingClient();

    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "creator-controlled-share",
          product: {
            ...packageInput(),
            price: {
              ...packageInput().price,
              creatorRevenueShareBps: 10_000,
            },
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_invalid",
      statusCode: 400,
    });

    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "invalid-package",
          product: {
            ...packageInput(),
            price: {
              amountMinor: 1_000,
              entitlementUnits: 333,
            },
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toBeInstanceOf(OwnerBillingProductError);
    expect(client.products).toHaveLength(0);

    await expect(
      getOwnerRepresentativeBillingCatalog(
        {
          ownerId: "owner-other",
          representativeSlug: "delegate",
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_not_found",
      statusCode: 404,
    });
  });
});

function packageInput() {
  return {
    name: "标准服务包",
    description: "当前代表专属",
    price: {
      amountMinor: 2_000,
      entitlementUnits: 1_000,
    },
  };
}

function metadata(idempotencyKey: string) {
  return {
    ownerId: "owner-1",
    representativeSlug: "delegate",
    requestId: `request:${idempotencyKey}`,
    idempotencyKey,
  };
}

function mutationInput(input: {
  idempotencyKey: string;
  product: unknown;
}) {
  return {
    ...metadata(input.idempotencyKey),
    product: input.product,
  };
}

type MemoryProduct = {
  id: string;
  representativeId: string;
  code: string;
  name: string;
  description: string | null;
  status: BillingProductStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

type MemoryPrice = {
  id: string;
  billingProductId: string;
  version: number;
  status: BillingPriceVersionStatus;
  currency: string;
  amountMinor: number;
  unitName: string;
  entitlementUnits: number;
  creatorRevenueShareBps: number;
  platformRevenueShareBps: number;
  refundPolicy: "FULL_WHEN_UNUSED";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
};

type MemoryAudit = {
  ownerId: string;
  representativeId: string;
  type: EventType;
  idempotencyKey: string;
  requestHash: string;
  payload: Record<string, unknown>;
};

class MemoryOwnerBillingClient {
  readonly representatives = [
    {
      id: "rep-1",
      ownerId: "owner-1",
      slug: "delegate",
      displayName: "Delegate",
      agentWallet: {
        currency: "CNY",
        creatorRevenueShareBps: 2_000,
      },
    },
    {
      id: "rep-2",
      ownerId: "owner-1",
      slug: "second-representative",
      displayName: "Second representative",
      agentWallet: {
        currency: "CNY",
        creatorRevenueShareBps: 2_000,
      },
    },
  ];
  readonly products: MemoryProduct[] = [];
  readonly prices: MemoryPrice[] = [];
  readonly audits: MemoryAudit[] = [];
  private sequence = 0;
  private readonly now = new Date("2026-07-29T08:00:00.000Z");

  asPrisma() {
    return this as unknown as PrismaClient;
  }

  $transaction = async <T>(
    operation: (client: this) => Promise<T>,
  ) => operation(this);

  $queryRaw = async (query: { values?: unknown[] }) => {
    const [productId, representativeId] = query.values ?? [];
    return this.products.some(
      (product) =>
        product.id === productId
        && product.representativeId === representativeId,
    )
      ? [{ id: productId }]
      : [];
  };

  representative = {
    findFirst: async (args: {
      where: { ownerId: string; slug: string };
      select: { billingProducts?: unknown };
    }) => {
      const representative = this.representatives.find(
        (candidate) =>
          candidate.ownerId === args.where.ownerId
          && candidate.slug === args.where.slug,
      );
      if (!representative) return null;
      if (!args.select.billingProducts) {
        return {
          id: representative.id,
          slug: representative.slug,
          agentWallet: representative.agentWallet,
        };
      }
      return {
        id: representative.id,
        slug: representative.slug,
        displayName: representative.displayName,
        agentWallet: representative.agentWallet,
        billingProducts: this.products
          .filter(
            (product) =>
              product.representativeId === representative.id,
          )
          .map((product) => this.productRecord(product)),
      };
    },
  };

  billingProduct = {
    create: async (args: { data: Omit<MemoryProduct, "id" | "createdAt" | "updatedAt"> }) => {
      const product: MemoryProduct = {
        ...args.data,
        id: `product-${++this.sequence}`,
        createdAt: new Date(this.now),
        updatedAt: new Date(this.now),
      };
      this.products.push(product);
      return { id: product.id };
    },
    findFirst: async (args: {
      where: { id: string; representativeId: string };
    }) => {
      const product = this.products.find(
        (candidate) =>
          candidate.id === args.where.id
          && candidate.representativeId
            === args.where.representativeId,
      );
      return product ? this.productRecord(product) : null;
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const product = this.products.find(
        (candidate) => candidate.id === args.where.id,
      )!;
      this.applyProductUpdate(product, args.data);
      return product;
    },
    updateMany: async (args: {
      where: {
        id: string;
        representativeId?: string;
        revision?: number;
        status?:
          | BillingProductStatus
          | { in: BillingProductStatus[] };
      };
      data: Record<string, unknown>;
    }) => {
      const product = this.products.find(
        (candidate) => candidate.id === args.where.id,
      );
      if (
        !product
        || (
          args.where.representativeId
          && product.representativeId
            !== args.where.representativeId
        )
        || (
          args.where.revision !== undefined
          && product.revision !== args.where.revision
        )
        || !matchesStatus(product.status, args.where.status)
      ) {
        return { count: 0 };
      }
      this.applyProductUpdate(product, args.data);
      return { count: 1 };
    },
  };

  billingPriceVersion = {
    create: async (args: {
      data: Omit<
        MemoryPrice,
        "id" | "publishedAt" | "retiredAt" | "createdAt"
      >;
    }) => {
      const price: MemoryPrice = {
        ...args.data,
        id: `price-${++this.sequence}`,
        publishedAt: null,
        retiredAt: null,
        createdAt: new Date(this.now),
      };
      this.prices.push(price);
      return { id: price.id };
    },
    update: async (args: {
      where: { id: string };
      data: Partial<MemoryPrice>;
    }) => {
      const price = this.prices.find(
        (candidate) => candidate.id === args.where.id,
      )!;
      Object.assign(price, args.data);
      return price;
    },
    updateMany: async (args: {
      where: {
        id: string;
        billingProductId: string;
        status: BillingPriceVersionStatus;
      };
      data: Partial<MemoryPrice>;
    }) => {
      const price = this.prices.find(
        (candidate) =>
          candidate.id === args.where.id
          && candidate.billingProductId
            === args.where.billingProductId
          && candidate.status === args.where.status,
      );
      if (!price) return { count: 0 };
      Object.assign(price, args.data);
      return { count: 1 };
    },
  };

  eventAudit = {
    findUnique: async (args: {
      where: {
        ownerId_idempotencyKey: {
          ownerId: string;
          idempotencyKey: string;
        };
      };
    }) => {
      const replay = this.audits.find(
        (event) =>
          event.ownerId
            === args.where.ownerId_idempotencyKey.ownerId
          && event.idempotencyKey
            === args.where.ownerId_idempotencyKey.idempotencyKey,
      );
      return replay
        ? {
            type: replay.type,
            requestHash: replay.requestHash,
            representativeId: replay.representativeId,
            payload: replay.payload,
          }
        : null;
    },
    create: async (args: { data: MemoryAudit }) => {
      if (
        this.audits.some(
          (event) =>
            event.ownerId === args.data.ownerId
            && event.idempotencyKey === args.data.idempotencyKey,
        )
      ) {
        throw Object.assign(new Error("duplicate audit"), {
          code: "P2002",
        });
      }
      this.audits.push({
        ...args.data,
        payload: { ...args.data.payload },
      });
      return args.data;
    },
  };

  private productRecord(product: MemoryProduct) {
    return {
      ...product,
      priceVersions: this.prices
        .filter((price) => price.billingProductId === product.id)
        .sort((left, right) => right.version - left.version)
        .map((price) => ({ ...price })),
    };
  }

  private applyProductUpdate(
    product: MemoryProduct,
    data: Record<string, unknown>,
  ) {
    if (typeof data.name === "string") product.name = data.name;
    if (
      typeof data.description === "string"
      || data.description === null
    ) {
      product.description = data.description;
    }
    if (typeof data.status === "string") {
      product.status = data.status as BillingProductStatus;
    }
    const revision = data.revision;
    if (
      revision
      && typeof revision === "object"
      && "increment" in revision
      && typeof revision.increment === "number"
    ) {
      product.revision += revision.increment;
    }
    product.updatedAt = new Date(
      product.updatedAt.getTime() + 1_000,
    );
  }
}

function matchesStatus(
  current: BillingProductStatus,
  expected:
    | BillingProductStatus
    | { in: BillingProductStatus[] }
    | undefined,
) {
  if (!expected) return true;
  return typeof expected === "string"
    ? current === expected
    : expected.in.includes(current);
}
