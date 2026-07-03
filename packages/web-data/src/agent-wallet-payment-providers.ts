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

export type StripeCheckoutSessionRecord = {
  id: string;
  url?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
};

export type StripeCheckoutSessionCreateParams = {
  mode: "payment";
  client_reference_id: string;
  success_url: string;
  cancel_url?: string;
  line_items: Array<{
    price_data: {
      currency: string;
      unit_amount: number;
      product_data: {
        name: string;
        metadata: Record<string, string>;
      };
    };
    quantity: number;
  }>;
  metadata: Record<string, string>;
};

export type StripeCheckoutSessionCreateOptions = {
  idempotencyKey?: string;
};

export type StripePaymentProviderConfig = {
  checkoutSessions: {
    create(
      params: StripeCheckoutSessionCreateParams,
      options?: StripeCheckoutSessionCreateOptions,
    ): Promise<StripeCheckoutSessionRecord>;
  };
  successUrl: string;
  cancelUrl?: string;
  productName?: string;
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

export function createStripePaymentProviderAdapter(
  config: StripePaymentProviderConfig,
): PaymentProviderAdapter {
  return {
    provider: PaymentProvider.STRIPE,
    async createRechargeCheckout(input) {
      assertPositiveInteger(input.amountCents, "amountCents");
      assertSupportedCurrency(input.currency);
      const externalUserId = requiredString(input.externalUserId, "externalUserId");
      const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");
      const metadata = {
        rechargeOrderId: input.rechargeOrderId ?? "",
        externalUserId,
        amountCents: String(input.amountCents),
        currency: input.currency,
        idempotencyKey,
      };
      const session = await config.checkoutSessions.create(
        {
          mode: "payment",
          client_reference_id: idempotencyKey,
          success_url: config.successUrl,
          ...(config.cancelUrl ? { cancel_url: config.cancelUrl } : {}),
          line_items: [
            {
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.amountCents,
                product_data: {
                  name: config.productName ?? "Delegate Agent Wallet recharge",
                  metadata,
                },
              },
              quantity: 1,
            },
          ],
          metadata,
        },
        { idempotencyKey },
      );

      return {
        provider: PaymentProvider.STRIPE,
        providerOrderId: session.id,
        checkoutUrl: session.url ?? null,
        providerPayload: {
          provider: "stripe",
          checkoutSessionId: session.id,
          checkoutUrl: session.url ?? null,
          metadata,
        },
      };
    },
    async normalizeWebhookEvent(input) {
      const payload = parseWebhookPayload(input);
      const eventId = requiredString(payload.id, "id");
      const eventType = requiredString(payload.type, "type");
      const data = readObject(payload.data, "data");
      const object = readObject(data.object, "data.object");
      const metadata = readStringRecord(object.metadata);
      const normalizedType = normalizeStripeEventType(eventType);
      const amountCents = readStripeAmountCents(object, metadata);
      const currency = readStripeCurrency(object, metadata);
      const rechargeOrderId = optionalString(metadata.rechargeOrderId) ?? null;

      return {
        provider: PaymentProvider.STRIPE,
        providerEventId: eventId,
        eventType: normalizedType,
        rechargeOrderId,
        amountCents,
        currency,
        rawPayload: toJsonValue(payload),
        normalizedPayload: {
          type:
            normalizedType === PaymentProviderEventType.RECHARGE_PAID
              ? "RechargePaid"
              : normalizedType === PaymentProviderEventType.RECHARGE_FAILED
                ? "RechargeFailed"
                : "PaymentProviderEvent",
          provider: "stripe",
          stripeEventType: eventType,
          rechargeOrderId,
          amountCents,
          currency,
        },
        idempotencyKey: `stripe:${eventId}`,
      };
    },
  };
}

export function getPaymentProviderAdapter(
  provider: PaymentProvider,
  config: { stripe?: StripePaymentProviderConfig } = {},
): PaymentProviderAdapter {
  if (provider === PaymentProvider.MOCK) {
    return mockPaymentProviderAdapter;
  }
  if (provider === PaymentProvider.STRIPE && config.stripe) {
    return createStripePaymentProviderAdapter(config.stripe);
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

function normalizeStripeEventType(eventType: string): PaymentProviderEventType {
  if (
    eventType === "checkout.session.completed" ||
    eventType === "checkout.session.async_payment_succeeded" ||
    eventType === "payment_intent.succeeded"
  ) {
    return PaymentProviderEventType.RECHARGE_PAID;
  }
  if (
    eventType === "checkout.session.async_payment_failed" ||
    eventType === "payment_intent.payment_failed"
  ) {
    return PaymentProviderEventType.RECHARGE_FAILED;
  }
  return PaymentProviderEventType.UNKNOWN;
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Stripe webhook ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function readStripeAmountCents(
  object: Record<string, unknown>,
  metadata: Record<string, string>,
): number | null {
  const metadataAmount = Number(metadata.amountCents);
  if (Number.isInteger(metadataAmount) && metadataAmount > 0) {
    return metadataAmount;
  }
  for (const key of ["amount_total", "amount_received", "amount"]) {
    const value = object[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function readStripeCurrency(
  object: Record<string, unknown>,
  metadata: Record<string, string>,
): string | null {
  const metadataCurrency = optionalString(metadata.currency);
  if (metadataCurrency) {
    return metadataCurrency.toUpperCase();
  }
  const objectCurrency = optionalString(object.currency);
  return objectCurrency ? objectCurrency.toUpperCase() : null;
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
