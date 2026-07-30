import { describe, expect, it } from "vitest";

import {
  listPublicServicePackages,
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

  it("fails closed for commercial terms the current ledger cannot fulfill", async () => {
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
    ).rejects.toMatchObject({
      code: "SERVICE_PACKAGE_INVALID",
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
    billingProduct: {
      id: "product-1",
      representativeId: "rep-1",
      name: "标准服务包",
      description: "用于当前数字代表",
      status: "ACTIVE",
    },
  };
}

class FakeBillingProductClient {
  constructor(
    private readonly versions: ReturnType<typeof activePriceVersion>[],
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
}
