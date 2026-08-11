import {
  BillingPriceVersionStatus,
  BillingProductKind,
  BillingProductStatus,
  EventType,
  RepresentativeAccessMode,
  RepresentativeHandoffAccessMode,
  type PrismaClient,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  OwnerBillingProductError,
  archiveOwnerBillingProduct,
  createAndPublishOwnerBillingProduct,
  getOwnerRepresentativeBillingCatalog,
  publishOwnerBillingPriceVersion,
  updateOwnerRepresentativeCommerceSettings,
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

  it("accepts arbitrary amount-to-credit ratios and fails closed for invalid units and scope", async () => {
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
          idempotencyKey: "arbitrary-ratio-package",
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
    ).resolves.toMatchObject({
      activePriceVersion: { amountMinor: 1_000, entitlementUnits: 333 },
    });

    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "invalid-package",
          product: {
            ...packageInput(),
            price: { amountMinor: 1_000, entitlementUnits: 0 },
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toBeInstanceOf(OwnerBillingProductError);
    expect(client.products).toHaveLength(1);

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

  it("maps nested price validation failures to their exact editor fields", async () => {
    const client = new MemoryOwnerBillingClient();
    let failure: unknown;

    try {
      await createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "invalid-nested-price-fields",
          product: {
            kind: "SERVICE_PACKAGE",
            name: "Invalid package",
            price: {
              amountMinor: 1_000_001,
              entitlementUnits: 10_000_001,
              handoffAllowance: "LIMITED",
              handoffUnits: 1_000_001,
              handoffServiceLevel: "PRIORITY",
              handoffValidityDays: 3_651,
            },
          },
        }),
        client.asPrisma(),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OwnerBillingProductError);
    expect(failure).toMatchObject({
      code: "billing_product_invalid",
      statusCode: 400,
      fieldErrors: {
        amountMinor: [expect.any(String)],
        entitlementUnits: [expect.any(String)],
        handoffUnits: [expect.any(String)],
        handoffValidityDays: [expect.any(String)],
      },
    });
    expect((failure as OwnerBillingProductError).fieldErrors)
      .not.toHaveProperty("price");
    expect(client.products).toHaveLength(0);
  });

  it("refuses to sell paid handoff benefits unless package-required handoff is live", async () => {
    const client = new MemoryOwnerBillingClient();

    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "handoff-not-live",
          product: {
            kind: "SERVICE_PACKAGE",
            name: "Unfulfillable handoff",
            price: {
              amountMinor: 1_000,
              entitlementUnits: 100,
              handoffAllowance: "LIMITED",
              handoffUnits: 1,
              handoffServiceLevel: "PRIORITY",
              handoffValidityDays: 30,
            },
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({
      code: "billing_product_conflict",
      statusCode: 409,
    });
    expect(client.products).toHaveLength(0);

    Object.assign(client.representatives[0]!, {
      humanInLoop: false,
      handoffAccessMode:
        RepresentativeHandoffAccessMode.PACKAGE_REQUIRED,
    });
    await expect(
      createAndPublishOwnerBillingProduct(
        mutationInput({
          idempotencyKey: "handoff-human-disabled",
          product: {
            kind: "SERVICE_PACKAGE",
            name: "Disabled human handoff",
            price: {
              amountMinor: 1_000,
              entitlementUnits: 100,
              handoffAllowance: "UNLIMITED",
              handoffServiceLevel: "STANDARD",
              handoffValidityDays: 30,
            },
          },
        }),
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });
    expect(client.products).toHaveLength(0);
  });

  it("configures commerce, validates handoff packages, and keeps tips non-entitling", async () => {
    const client = new MemoryOwnerBillingClient();
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        {
          ...metadata("enable-tips"),
          settings: {
            tipsEnabled: true,
            handoffAccessMode: "PACKAGE_REQUIRED",
          },
        },
        client.asPrisma(),
      ),
    ).resolves.toMatchObject({
      tipsEnabled: true,
      handoffAccessMode: "PACKAGE_REQUIRED",
    });

    const servicePackage = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "create-handoff-package",
        product: {
          kind: "SERVICE_PACKAGE",
          name: "优先转接包",
          sortOrder: 2,
          isRecommended: true,
          price: {
            amountMinor: 1_000,
            entitlementUnits: 333,
            handoffAllowance: "LIMITED",
            handoffUnits: 2,
            handoffServiceLevel: "PRIORITY",
            handoffValidityDays: 30,
          },
        },
      }),
      client.asPrisma(),
    );
    expect(servicePackage).toMatchObject({
      kind: "SERVICE_PACKAGE",
      sortOrder: 2,
      isRecommended: true,
      activePriceVersion: {
        handoffAllowance: "LIMITED",
        handoffUnits: 2,
        handoffServiceLevel: "PRIORITY",
        handoffValidityDays: 30,
      },
    });

    const tip = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "create-tip",
        product: {
          kind: "TIP",
          name: "支持一下",
          price: { amountMinor: 100 },
        },
      }),
      client.asPrisma(),
    );
    expect(tip).toMatchObject({
      kind: "TIP",
      activePriceVersion: {
        unitName: "tip",
        entitlementUnits: 0,
        refundPolicy: "NON_REFUNDABLE",
        handoffAllowance: "NONE",
      },
    });

    await expect(
      updateOwnerRepresentativeCommerceSettings(
        { ...metadata("switch-free"), settings: { accessMode: "FREE" } },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        { ...metadata("disable-tips"), settings: { tipsEnabled: false } },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        {
          ...metadata("disable-paid-handoff"),
          settings: { handoffAccessMode: "FREE" },
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        {
          ...metadata("disable-human-with-paid-handoff"),
          settings: { humanInLoop: false },
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });
  });

  it("protects sold handoff grants after the catalog stops selling that benefit", async () => {
    const client = new MemoryOwnerBillingClient();
    await updateOwnerRepresentativeCommerceSettings(
      {
        ...metadata("enable-package-handoff"),
        settings: { handoffAccessMode: "PACKAGE_REQUIRED" },
      },
      client.asPrisma(),
    );
    const product = await createAndPublishOwnerBillingProduct(
      mutationInput({
        idempotencyKey: "create-expiring-handoff",
        product: {
          kind: "SERVICE_PACKAGE",
          name: "Handoff bundle",
          price: {
            amountMinor: 1_000,
            entitlementUnits: 100,
            handoffAllowance: "LIMITED",
            handoffUnits: 1,
            handoffServiceLevel: "STANDARD",
            handoffValidityDays: 30,
          },
        },
      }),
      client.asPrisma(),
    );
    const withoutHandoff = await publishOwnerBillingPriceVersion(
      {
        ...metadata("retire-handoff-benefit"),
        productId: product.id,
        priceVersion: {
          expectedRevision: product.revision,
          expectedActivePriceVersionId: product.activePriceVersion!.id,
          price: { amountMinor: 1_000, entitlementUnits: 100 },
        },
      },
      client.asPrisma(),
    );
    expect(withoutHandoff.activePriceVersion).toMatchObject({
      handoffAllowance: "NONE",
    });

    client.activeHandoffGrantCount = 1;
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        {
          ...metadata("disable-with-sold-grant"),
          settings: { handoffAccessMode: "FREE" },
        },
        client.asPrisma(),
      ),
    ).rejects.toMatchObject({ code: "billing_product_conflict" });

    client.activeHandoffGrantCount = 0;
    await expect(
      updateOwnerRepresentativeCommerceSettings(
        {
          ...metadata("disable-after-grant-settled"),
          settings: { handoffAccessMode: "FREE" },
        },
        client.asPrisma(),
      ),
    ).resolves.toMatchObject({ handoffAccessMode: "FREE" });
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
  kind: BillingProductKind;
  sortOrder: number;
  isRecommended: boolean;
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
  refundPolicy: "FULL_WHEN_UNUSED" | "NON_REFUNDABLE";
  expiryPolicy: "NEVER_EXPIRES";
  entitlementValidityDays: null;
  handoffAllowance: "NONE" | "LIMITED" | "UNLIMITED";
  handoffUnits: number | null;
  handoffServiceLevel: "STANDARD" | "PRIORITY" | null;
  handoffValidityDays: number | null;
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
      accessMode: RepresentativeAccessMode.TRIAL_THEN_CREDITS,
      handoffAccessMode: RepresentativeHandoffAccessMode.FREE,
      tipsEnabled: false,
      freeReplyLimit: 4,
      humanInLoop: true,
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
      accessMode: RepresentativeAccessMode.TRIAL_THEN_CREDITS,
      handoffAccessMode: RepresentativeHandoffAccessMode.FREE,
      tipsEnabled: false,
      freeReplyLimit: 4,
      humanInLoop: true,
      agentWallet: {
        currency: "CNY",
        creatorRevenueShareBps: 2_000,
      },
    },
  ];
  readonly products: MemoryProduct[] = [];
  readonly prices: MemoryPrice[] = [];
  readonly audits: MemoryAudit[] = [];
  activeHandoffGrantCount = 0;
  activePaidHandoffRequestCount = 0;
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
    if (representativeId === undefined) {
      return this.representatives.some(
        (representative) => representative.id === productId,
      )
        ? [{ id: productId }]
        : [];
    }
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
          displayName: representative.displayName,
          accessMode: representative.accessMode,
          handoffAccessMode: representative.handoffAccessMode,
          tipsEnabled: representative.tipsEnabled,
          freeReplyLimit: representative.freeReplyLimit,
          humanInLoop: representative.humanInLoop,
          agentWallet: representative.agentWallet,
        };
      }
      return {
        id: representative.id,
        slug: representative.slug,
        displayName: representative.displayName,
        accessMode: representative.accessMode,
        handoffAccessMode: representative.handoffAccessMode,
        tipsEnabled: representative.tipsEnabled,
        freeReplyLimit: representative.freeReplyLimit,
        humanInLoop: representative.humanInLoop,
        agentWallet: representative.agentWallet,
        billingProducts: this.products
          .filter(
            (product) =>
              product.representativeId === representative.id,
          )
          .map((product) => this.productRecord(product)),
      };
    },
    update: async (args: {
      where: { id: string };
      data: Partial<{
        accessMode: RepresentativeAccessMode;
        handoffAccessMode: RepresentativeHandoffAccessMode;
        tipsEnabled: boolean;
        freeReplyLimit: number;
        humanInLoop: boolean;
      }>;
    }) => {
      const representative = this.representatives.find(
        (candidate) => candidate.id === args.where.id,
      )!;
      Object.assign(representative, args.data);
      return representative;
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
    count: async (args: {
      where: {
        representativeId: string;
        kind: BillingProductKind;
        status: BillingProductStatus;
      };
    }) => this.products.filter(
      (product) =>
        product.representativeId === args.where.representativeId
        && product.kind === args.where.kind
        && product.status === args.where.status,
    ).length,
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
    count: async (args: {
      where: {
        status: BillingPriceVersionStatus;
        handoffAllowance: { not: "NONE" };
        billingProduct: {
          representativeId: string;
          kind: BillingProductKind;
          status: BillingProductStatus;
        };
      };
    }) => this.prices.filter((price) => {
      const product = this.products.find(
        (candidate) => candidate.id === price.billingProductId,
      );
      return price.status === args.where.status
        && price.handoffAllowance !== args.where.handoffAllowance.not
        && product?.representativeId
          === args.where.billingProduct.representativeId
        && product.kind === args.where.billingProduct.kind
        && product.status === args.where.billingProduct.status;
    }).length,
  };

  handoffEntitlementGrant = {
    count: async () => this.activeHandoffGrantCount,
  };

  handoffRequest = {
    count: async () => this.activePaidHandoffRequestCount,
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
    if (typeof data.sortOrder === "number") product.sortOrder = data.sortOrder;
    if (typeof data.isRecommended === "boolean") {
      product.isRecommended = data.isRecommended;
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
