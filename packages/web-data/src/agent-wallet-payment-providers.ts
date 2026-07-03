import {
  PaymentProvider,
  PaymentProviderEventType,
  type Prisma,
} from "@prisma/client";

export type RechargeCheckoutInput = {
  rechargeOrderId?: string;
  externalUserId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
};

export type RechargeCheckoutSession = {
  provider: PaymentProvider;
  providerOrderId: string;
  checkoutUrl: string | null;
  providerPayload: Prisma.InputJsonValue;
};

export type PaymentProviderWebhookInput = {
  headers?: Record<string, string | undefined>;
  rawBody?: string;
  payload?: unknown;
};

export type NormalizedPaymentProviderEvent = {
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
  amountCents: number | null;
  currency: string | null;
  rawPayload: Prisma.InputJsonValue;
  normalizedPayload: Prisma.InputJsonValue;
  idempotencyKey: string;
};

export type PaymentProviderAdapter = {
  provider: PaymentProvider;
  createRechargeCheckout(input: RechargeCheckoutInput): Promise<RechargeCheckoutSession>;
  normalizeWebhookEvent(
    input: PaymentProviderWebhookInput,
  ): Promise<NormalizedPaymentProviderEvent>;
};

const SUPPORTED_PAYMENT_CURRENCIES = new Set(["CNY", "USD"]);

export const mockPaymentProviderAdapter: PaymentProviderAdapter = {
  provider: PaymentProvider.MOCK,
  async createRechargeCheckout(input) {
    assertPositiveInteger(input.amountCents, "amountCents");
    assertSupportedCurrency(input.currency);
    const externalUserId = requiredString(input.externalUserId, "externalUserId");
    const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");

    return {
      provider: PaymentProvider.MOCK,
      providerOrderId: `mock_${idempotencyKey}`,
      checkoutUrl: `/api/amn/recharges/mock/${idempotencyKey}`,
      providerPayload: {
        provider: "mock",
        rechargeOrderId: input.rechargeOrderId ?? null,
        externalUserId,
        amountCents: input.amountCents,
        currency: input.currency,
        idempotencyKey,
      },
    };
  },
  async normalizeWebhookEvent(input) {
    const payload = parseWebhookPayload(input);
    const rechargeOrderId = requiredString(payload.rechargeOrderId, "rechargeOrderId");
    const amountCents = Number(payload.amountCents);
    assertPositiveInteger(amountCents, "amountCents");
    const currency = requiredString(payload.currency, "currency");
    assertSupportedCurrency(currency);

    const status = String(payload.status ?? "paid").toLowerCase();
    const eventType =
      status === "failed" || payload.success === false
        ? PaymentProviderEventType.RECHARGE_FAILED
        : PaymentProviderEventType.RECHARGE_PAID;
    const providerEventId =
      optionalString(payload.providerEventId) ??
      `mock_recharge_${eventType === PaymentProviderEventType.RECHARGE_PAID ? "paid" : "failed"}_${rechargeOrderId}`;

    return {
      provider: PaymentProvider.MOCK,
      providerEventId,
      eventType,
      rechargeOrderId,
      amountCents,
      currency,
      rawPayload: toJsonValue(payload),
      normalizedPayload: {
        type:
          eventType === PaymentProviderEventType.RECHARGE_PAID
            ? "RechargePaid"
            : "RechargeFailed",
        provider: "mock",
        rechargeOrderId,
        amountCents,
        currency,
      },
      idempotencyKey: `mock:${providerEventId}`,
    };
  },
};

export function getPaymentProviderAdapter(provider: PaymentProvider): PaymentProviderAdapter {
  if (provider === PaymentProvider.MOCK) {
    return mockPaymentProviderAdapter;
  }
  return createReservedPaymentProviderAdapter(provider);
}

export function createReservedPaymentProviderAdapter(
  provider: Exclude<PaymentProvider, typeof PaymentProvider.MOCK>,
): PaymentProviderAdapter {
  return {
    provider,
    async createRechargeCheckout() {
      throw new Error(`${provider} payment adapter is reserved but not configured.`);
    },
    async normalizeWebhookEvent() {
      throw new Error(`${provider} payment adapter is reserved but not configured.`);
    },
  };
}

function parseWebhookPayload(input: PaymentProviderWebhookInput): Record<string, unknown> {
  if (typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)) {
    return input.payload as Record<string, unknown>;
  }
  if (typeof input.rawBody === "string" && input.rawBody.trim()) {
    const parsed = JSON.parse(input.rawBody) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error("Payment provider webhook payload must be a JSON object.");
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || typeof value === "undefined") {
    return {};
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item)) as Prisma.InputJsonArray;
  }
  if (typeof value === "object") {
    const jsonObject: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "undefined") {
        jsonObject[key] = toJsonValue(item);
      }
    }
    return jsonObject as Prisma.InputJsonObject;
  }
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertSupportedCurrency(currency: string): void {
  if (!SUPPORTED_PAYMENT_CURRENCIES.has(currency)) {
    throw new Error(`Unsupported payment currency: ${currency}`);
  }
}
