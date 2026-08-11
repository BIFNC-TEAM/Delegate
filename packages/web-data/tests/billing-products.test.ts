import { describe, expect, it } from "vitest";

import {
  listPublicCommerceProducts,
  listPublicServicePackages,
  resolvePublicCommerceProduct,
  resolvePublicServicePackage,
} from "../src/billing-products";

describe("public billing products", () => {
  it("lists only valid active CNY packages for the selected representative", async () => {
    const client = new FakeBillingProductClient([
      activePriceVersion(),
      {
        ...activePriceVersion(),
        id: "price-expiring",
        expiryPolicy: "VALID_FOR_DAYS",
        entitlementValidityDays: 30,
      } as unknown as ReturnType<typeof activePriceVersion>,
    ]);

    await expect(
      listPublicServicePackages(
        { representativeId: "rep-1", currency: "CNY" },
        client,
      ),
    ).resolves.toEqual([
      {
        productId: "product-1",
        priceVersionId: "price-1",
        name: "标准服务包",
        description: "用于当前数字代表",
        amountCents: 2000,
        currency: "CNY",
        entitlementUnits: 1000,
        unitName: "credit",
        refundPolicy: "FULL_WHEN_UNUSED",
        expiryPolicy: "NEVER_EXPIRES",
      },
    ]);
  });

  it("rejects a cross-representative or inactive version", async () => {
    const crossRepresentative = new FakeBillingProductClient([
      {
        ...activePriceVersion(),
        billingProduct: {
          ...activePriceVersion().billingProduct,
          representativeId: "rep-other",
        },
      },
    ]);
    await expect(
      resolvePublicServicePackage(
        {
          representativeId: "rep-1",
          billingPriceVersionId: "price-1",
        },
        crossRepresentative,
      ),
    ).rejects.toMatchObject({
      code: "SERVICE_PACKAGE_UNAVAILABLE",
    });

    const retired = new FakeBillingProductClient([
      { ...activePriceVersion(), status: "RETIRED" },
    ]);
    await expect(
      resolvePublicServicePackage(
        {
          representativeId: "rep-1",
          billingPriceVersionId: "price-1",
        },
        retired,
      ),
    ).rejects.toMatchObject({
      code: "SERVICE_PACKAGE_UNAVAILABLE",
    });
  });

  it("accepts arbitrary price ratios and fails closed for unsupported terms", async () => {
    const client = new FakeBillingProductClient([
      {
        ...activePriceVersion(),
        amountMinor: 1000,
        entitlementUnits: 333,
      },
    ]);

    await expect(
      resolvePublicServicePackage(
        {
          representativeId: "rep-1",
          billingPriceVersionId: "price-1",
        },
        client,
      ),
    ).resolves.toMatchObject({
      amountCents: 1_000,
      entitlementUnits: 333,
    });

    const unsupportedUnit = new FakeBillingProductClient([
      {
        ...activePriceVersion(),
        unitName: "session",
      },
    ]);
    await expect(
      resolvePublicServicePackage(
        {
          representativeId: "rep-1",
          billingPriceVersionId: "price-1",
        },
        unsupportedUnit,
      ),
    ).rejects.toMatchObject({
      code: "SERVICE_PACKAGE_INVALID",
    });
  });

  it("returns a unified ordered catalog and enforces representative commerce settings", async () => {
    const service = {
      ...activePriceVersion(),
      amountMinor: 1_000,
      entitlementUnits: 333,
      handoffAllowance: "LIMITED",
      handoffUnits: 2,
      handoffServiceLevel: "PRIORITY",
      handoffValidityDays: 30,
      billingProduct: {
        ...activePriceVersion().billingProduct,
        kind: "SERVICE_PACKAGE",
        sortOrder: 2,
        isRecommended: true,
      },
    };
    const tip = {
      ...activePriceVersion(),
      id: "price-tip",
      billingProductId: "product-tip",
      amountMinor: 100,
      unitName: "tip",
      entitlementUnits: 0,
      refundPolicy: "NON_REFUNDABLE",
      handoffAllowance: "NONE",
      billingProduct: {
        ...activePriceVersion().billingProduct,
        id: "product-tip",
        name: "支持一下",
        kind: "TIP",
        sortOrder: 1,
        isRecommended: false,
      },
    };
    const client = new FakeBillingProductClient(
      [service, tip] as ReturnType<typeof activePriceVersion>[],
      { accessMode: "TRIAL_THEN_CREDITS", tipsEnabled: true },
    );

    await expect(
      listPublicCommerceProducts({ representativeId: "rep-1" }, client),
    ).resolves.toMatchObject([
      { kind: "TIP", priceVersionId: "price-tip", sortOrder: 1 },
      {
        kind: "SERVICE_PACKAGE",
        priceVersionId: "price-1",
        sortOrder: 2,
        isRecommended: true,
        handoffAllowance: "LIMITED",
        handoffUnits: 2,
        handoffServiceLevel: "PRIORITY",
        handoffValidityDays: 30,
      },
    ]);
    await expect(
      resolvePublicCommerceProduct(
        { representativeId: "rep-1", billingPriceVersionId: "price-tip" },
        client,
      ),
    ).resolves.toMatchObject({
      kind: "TIP",
      entitlementUnits: 0,
      refundPolicy: "NON_REFUNDABLE",
    });

    const disabled = new FakeBillingProductClient(
      [service, tip] as ReturnType<typeof activePriceVersion>[],
      { accessMode: "FREE", tipsEnabled: false },
    );
    await expect(
      listPublicCommerceProducts({ representativeId: "rep-1" }, disabled),
    ).resolves.toEqual([]);
    await expect(
      resolvePublicCommerceProduct(
        { representativeId: "rep-1", billingPriceVersionId: "price-tip" },
        disabled,
      ),
    ).rejects.toMatchObject({ code: "COMMERCE_PRODUCT_UNAVAILABLE" });
  });
});

function activePriceVersion() {
  return {
    id: "price-1",
    billingProductId: "product-1",
    status: "ACTIVE",
    currency: "CNY",
    amountMinor: 2000,
    unitName: "credit",
    entitlementUnits: 1000,
    creatorRevenueShareBps: 2000,
    platformRevenueShareBps: 8000,
    refundPolicy: "FULL_WHEN_UNUSED",
    expiryPolicy: "NEVER_EXPIRES",
    entitlementValidityDays: null,
    handoffAllowance: "NONE",
    handoffUnits: null,
    handoffServiceLevel: null,
    handoffValidityDays: null,
    billingProduct: {
      id: "product-1",
      representativeId: "rep-1",
      name: "标准服务包",
      description: "用于当前数字代表",
      kind: "SERVICE_PACKAGE",
      sortOrder: 0,
      isRecommended: false,
      status: "ACTIVE",
    },
  };
}

class FakeBillingProductClient {
  constructor(
    private readonly versions: ReturnType<typeof activePriceVersion>[],
    private readonly settings?: {
      accessMode: "FREE" | "TRIAL_THEN_CREDITS" | "CREDITS_ONLY";
      tipsEnabled: boolean;
    },
  ) {}

  billingPriceVersion = {
    findMany: async (_args: unknown) => this.versions,
    findUnique: async (args: unknown) => {
      const id = (
        args as { where: { id: string } }
      ).where.id;
      return this.versions.find((version) => version.id === id) ?? null;
    },
  };

  representative = {
    findUnique: async (_args: unknown) => this.settings ?? {
      accessMode: "TRIAL_THEN_CREDITS" as const,
      tipsEnabled: false,
    },
  };
}
