import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OwnerBillingProductError extends Error {
    code: string;
    statusCode: number;
    fieldErrors?: Record<string, string[]>;

    constructor(
      code: string,
      message: string,
      statusCode: number,
      fieldErrors?: Record<string, string[]>,
    ) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      if (fieldErrors) this.fieldErrors = fieldErrors;
    }
  }

  return {
    OwnerBillingProductError,
    archiveOwnerBillingProduct: vi.fn(),
    createAndPublishOwnerBillingProduct: vi.fn(),
    dashboardAuthErrorResponse: vi.fn(),
    getOwnerRepresentativeBillingCatalog: vi.fn(),
    publishOwnerBillingPriceVersion: vi.fn(),
    requireDashboardRepresentativeBillingAccess: vi.fn(),
    resolveDashboardRequestMetadata: vi.fn(),
    updateOwnerBillingProduct: vi.fn(),
    updateOwnerRepresentativeCommerceSettings: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  OwnerBillingProductError: mocks.OwnerBillingProductError,
  archiveOwnerBillingProduct: mocks.archiveOwnerBillingProduct,
  createAndPublishOwnerBillingProduct:
    mocks.createAndPublishOwnerBillingProduct,
  getOwnerRepresentativeBillingCatalog:
    mocks.getOwnerRepresentativeBillingCatalog,
  publishOwnerBillingPriceVersion:
    mocks.publishOwnerBillingPriceVersion,
  updateOwnerBillingProduct: mocks.updateOwnerBillingProduct,
  updateOwnerRepresentativeCommerceSettings:
    mocks.updateOwnerRepresentativeCommerceSettings,
}));

vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess:
    mocks.requireDashboardRepresentativeBillingAccess,
}));

vi.mock("../app/api/dashboard/request-metadata", () => ({
  resolveDashboardRequestMetadata:
    mocks.resolveDashboardRequestMetadata,
}));

import {
  GET as getProducts,
  PATCH as updateCommerceSettings,
  POST as createProduct,
} from "../app/api/dashboard/representatives/[slug]/billing-products/route";
import { PATCH as updateProduct } from "../app/api/dashboard/representatives/[slug]/billing-products/[productId]/route";
import { POST as archiveProduct } from "../app/api/dashboard/representatives/[slug]/billing-products/[productId]/archive/route";
import { POST as publishPriceVersion } from "../app/api/dashboard/representatives/[slug]/billing-products/[productId]/price-versions/route";

const activeProduct = {
  id: "product-1",
  name: "Starter package",
  revision: 2,
  status: "ACTIVE",
  activePriceVersion: {
    id: "price-2",
    version: 2,
    amountMinor: 500,
    entitlementUnits: 50,
  },
};

describe("dashboard representative billing product routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeBillingAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.resolveDashboardRequestMetadata.mockReturnValue({
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
    mocks.getOwnerRepresentativeBillingCatalog.mockResolvedValue({
      representative: { id: "rep-1", slug: "sktone", name: "SKTone" },
      products: [activeProduct],
    });
    mocks.createAndPublishOwnerBillingProduct.mockResolvedValue(
      activeProduct,
    );
    mocks.updateOwnerBillingProduct.mockResolvedValue(activeProduct);
    mocks.updateOwnerRepresentativeCommerceSettings.mockResolvedValue({
      id: "rep-1",
      slug: "sktone",
      accessMode: "TRIAL_THEN_CREDITS",
      freeReplyLimit: 3,
      humanInLoop: true,
      handoffAccessMode: "PACKAGE_REQUIRED",
      tipsEnabled: true,
    });
    mocks.publishOwnerBillingPriceVersion.mockResolvedValue(
      activeProduct,
    );
    mocks.archiveOwnerBillingProduct.mockResolvedValue({
      ...activeProduct,
      revision: 3,
      status: "ARCHIVED",
      activePriceVersion: null,
    });
  });

  it("lists only the authenticated owner's representative catalog", async () => {
    const response = await getProducts(
      new Request(
        "http://localhost/api/dashboard/representatives/sktone/billing-products",
      ),
      { params: Promise.resolve({ slug: "sktone" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireDashboardRepresentativeBillingAccess)
      .toHaveBeenCalledWith("sktone");
    expect(mocks.getOwnerRepresentativeBillingCatalog)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        representativeSlug: "sktone",
      });
    await expect(response.json()).resolves.toMatchObject({
      representative: { id: "rep-1", slug: "sktone" },
      products: [{ id: "product-1" }],
    });
  });

  it("creates and publishes a package in one owner-scoped request", async () => {
    const product = {
      name: "Starter package",
      description: "50 credits",
      price: {
        amountMinor: 500,
        entitlementUnits: 50,
      },
    };
    const request = jsonRequest(
      "http://localhost/api/dashboard/representatives/sktone/billing-products",
      "POST",
      product,
    );

    const response = await createProduct(request, {
      params: Promise.resolve({ slug: "sktone" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.createAndPublishOwnerBillingProduct)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        representativeSlug: "sktone",
        requestId: "request-1",
        idempotencyKey: "idempotency-1",
        product,
      });
    await expect(response.json()).resolves.toMatchObject({
      requestId: "request-1",
      product: { id: "product-1" },
    });
  });

  it("forwards only the submitted commerce settings patch with request metadata", async () => {
    const settings = {
      tipsEnabled: true,
      handoffAccessMode: "PACKAGE_REQUIRED",
    };
    const response = await updateCommerceSettings(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products",
        "PATCH",
        settings,
      ),
      { params: Promise.resolve({ slug: "sktone" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.updateOwnerRepresentativeCommerceSettings)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        representativeSlug: "sktone",
        requestId: "request-1",
        idempotencyKey: "idempotency-1",
        settings,
      });
    await expect(response.json()).resolves.toMatchObject({
      requestId: "request-1",
      representative: {
        id: "rep-1",
        tipsEnabled: true,
        handoffAccessMode: "PACKAGE_REQUIRED",
      },
    });
  });

  it("forwards revision guards for metadata, price, and archive mutations", async () => {
    const metadata = {
      expectedRevision: 2,
      name: "Starter package plus",
      description: null,
    };
    const updateResponse = await updateProduct(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products/product-1",
        "PATCH",
        metadata,
      ),
      {
        params: Promise.resolve({
          slug: "sktone",
          productId: "product-1",
        }),
      },
    );
    expect(updateResponse.status).toBe(200);
    expect(mocks.updateOwnerBillingProduct).toHaveBeenCalledWith({
      ownerId: "owner-1",
      representativeSlug: "sktone",
      productId: "product-1",
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      product: metadata,
    });

    const priceVersion = {
      expectedRevision: 2,
      expectedActivePriceVersionId: "price-2",
      price: {
        amountMinor: 1000,
        entitlementUnits: 120,
      },
    };
    const publishResponse = await publishPriceVersion(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products/product-1/price-versions",
        "POST",
        priceVersion,
      ),
      {
        params: Promise.resolve({
          slug: "sktone",
          productId: "product-1",
        }),
      },
    );
    expect(publishResponse.status).toBe(201);
    expect(mocks.publishOwnerBillingPriceVersion)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        representativeSlug: "sktone",
        productId: "product-1",
        requestId: "request-1",
        idempotencyKey: "idempotency-1",
        priceVersion,
      });

    const archive = { expectedRevision: 3 };
    const archiveResponse = await archiveProduct(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products/product-1/archive",
        "POST",
        archive,
      ),
      {
        params: Promise.resolve({
          slug: "sktone",
          productId: "product-1",
        }),
      },
    );
    expect(archiveResponse.status).toBe(200);
    expect(mocks.archiveOwnerBillingProduct).toHaveBeenCalledWith({
      ownerId: "owner-1",
      representativeSlug: "sktone",
      productId: "product-1",
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      archive,
    });
  });

  it("authorizes before reading a mutation body", async () => {
    const authorizationError = new Error("Authentication required.");
    mocks.requireDashboardRepresentativeBillingAccess.mockRejectedValue(
      authorizationError,
    );
    const authResponse = Response.json(
      { error: "Authentication required." },
      {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
    mocks.dashboardAuthErrorResponse.mockReturnValue(authResponse);
    const json = vi.fn();
    const request = {
      headers: new Headers(),
      json,
    } as unknown as Request;

    const response = await createProduct(request, {
      params: Promise.resolve({ slug: "sktone" }),
    });

    expect(response).toBe(authResponse);
    expect(json).not.toHaveBeenCalled();
    expect(mocks.resolveDashboardRequestMetadata).not.toHaveBeenCalled();
    expect(mocks.createAndPublishOwnerBillingProduct)
      .not.toHaveBeenCalled();
  });

  it("returns typed validation failures without caching them", async () => {
    mocks.createAndPublishOwnerBillingProduct.mockRejectedValue(
      new mocks.OwnerBillingProductError(
        "billing_product_invalid",
        "The service package is invalid.",
        400,
        { amountMinor: ["Amount must be an integer."] },
      ),
    );

    const response = await createProduct(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products",
        "POST",
        { name: "" },
      ),
      { params: Promise.resolve({ slug: "sktone" }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "The service package is invalid.",
      code: "billing_product_invalid",
      fieldErrors: {
        amountMinor: ["Amount must be an integer."],
      },
    });
  });

  it("does not expose unexpected backend errors", async () => {
    mocks.createAndPublishOwnerBillingProduct.mockRejectedValue(
      new Error("postgres://owner:secret@internal/billing"),
    );

    const response = await createProduct(
      jsonRequest(
        "http://localhost/api/dashboard/representatives/sktone/billing-products",
        "POST",
        { name: "Starter" },
      ),
      { params: Promise.resolve({ slug: "sktone" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain(
      "The service package request could not be completed.",
    );
    expect(body).not.toContain("secret");
    expect(body).not.toContain("postgres://");
  });
});

function jsonRequest(
  url: string,
  method: "PATCH" | "POST",
  body: unknown,
) {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "idempotency-1",
      "X-Request-Id": "request-1",
    },
    body: JSON.stringify(body),
  });
}
