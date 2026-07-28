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
  /**
   * Provider-safe, immutable request facts prepared before the first network
   * call. Recovery workers reuse this value so an ambiguous provider outcome
   * can be queried first and, only when absent, retried with the same request.
   */
  preparedProviderPayload?: unknown;
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
  providerTransactionId: string | null;
  eventType: PaymentProviderEventType;
  rechargeOrderId: string | null;
  providerOrderId: string | null;
  amountCents: number | null;
  currency: string | null;
  rawPayload: Prisma.InputJsonValue;
  normalizedPayload: Prisma.InputJsonValue;
  idempotencyKey: string;
  verifiedAt: Date | null;
  providerOccurredAt?: Date | null;
};

export type PaymentProviderAdapter = {
  provider: PaymentProvider;
  /**
   * This hook must be local and side-effect free. Its result is persisted in
   * the same transaction as the CREATED recharge order and durable outbox.
   */
  prepareRechargeCheckout?(
    input: RechargeCheckoutInput,
  ): Promise<Prisma.InputJsonValue>;
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
  verifyAndParseWebhook?: (
    input: PaymentProviderWebhookInput,
  ) => Promise<PaymentProviderWebhookVerification>;
};

export type SignedWalletCheckoutRecord = {
  providerOrderId: string;
  checkoutUrl?: string | null;
  rawPayload?: Record<string, unknown>;
};

export type SignedWalletProviderConfig = {
  appId: string;
  merchantId: string;
  prepareRechargeCheckout?: (
    input: RechargeCheckoutInput,
  ) => Promise<Record<string, unknown>>;
  createRechargeCheckout?: (
    input: RechargeCheckoutInput,
  ) => Promise<SignedWalletCheckoutRecord>;
  verifyAndParseWebhook?: (
    input: PaymentProviderWebhookInput,
  ) => Promise<PaymentProviderWebhookVerification>;
};

export type PaymentProviderWebhookVerification =
  | {
      verified: true;
      payload: Record<string, unknown>;
      /**
       * Provider-safe evidence to retain for audit. This must never contain
       * decrypted payer details, credentials, or signing keys.
       */
      rawPayload?: Record<string, unknown>;
      verifiedAt?: Date;
    }
  | {
      verified: false;
      reason?: string;
    };

export class PaymentProviderWebhookVerificationError extends Error {
  readonly code = "PAYMENT_PROVIDER_WEBHOOK_VERIFICATION_FAILED";

  constructor(provider: string) {
    super(`${provider} webhook signature verification failed.`);
    this.name = "PaymentProviderWebhookVerificationError";
  }
}

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
      providerTransactionId: null,
      eventType,
      rechargeOrderId,
      providerOrderId: optionalString(payload.providerOrderId) ?? null,
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
      verifiedAt: null,
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
      if (!config.verifyAndParseWebhook) {
        throw new Error("STRIPE webhooks require signature verification before parsing.");
      }
      const verification = await config.verifyAndParseWebhook(input);
      const payload = requireVerifiedWebhookPayload(verification, "STRIPE");
      const eventId = requiredString(payload.id, "id");
      const eventType = requiredString(payload.type, "type");
      const data = readObject(payload.data, "data");
      const object = readObject(data.object, "data.object");
      const metadata = readStringRecord(object.metadata);
      const normalizedType = normalizeStripeEventType(eventType, object);
      const amountCents = readStripeAmountCents(object, metadata);
      const currency = readStripeCurrency(object, metadata);
      const rechargeOrderId = optionalString(metadata.rechargeOrderId) ?? null;
      const providerOrderId =
        optionalString(metadata.providerOrderId) ?? optionalString(object.id) ?? null;

      return {
        provider: PaymentProvider.STRIPE,
        providerEventId: eventId,
        providerTransactionId:
          optionalString(object.payment_intent)
          ?? optionalString(object.id)
          ?? null,
        eventType: normalizedType,
        rechargeOrderId,
        providerOrderId,
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
          providerOrderId,
          amountCents,
          currency,
        },
        idempotencyKey: `stripe:${eventId}`,
        verifiedAt:
          verification.verified ? verification.verifiedAt ?? null : null,
      };
    },
  };
}

export function createWeChatPayPaymentProviderAdapter(
  config: SignedWalletProviderConfig,
): PaymentProviderAdapter {
  return createSignedWalletPaymentProviderAdapter(
    PaymentProvider.WECHAT_PAY,
    "wechat_pay",
    config,
  );
}

export function createAlipayPaymentProviderAdapter(
  config: SignedWalletProviderConfig,
): PaymentProviderAdapter {
  return createSignedWalletPaymentProviderAdapter(PaymentProvider.ALIPAY, "alipay", config);
}

export function getPaymentProviderAdapter(
  provider: PaymentProvider,
  config: {
    stripe?: StripePaymentProviderConfig;
    wechatPay?: SignedWalletProviderConfig;
    alipay?: SignedWalletProviderConfig;
  } = {},
): PaymentProviderAdapter {
  if (provider === PaymentProvider.MOCK) {
    return mockPaymentProviderAdapter;
  }
  if (provider === PaymentProvider.STRIPE && config.stripe) {
    return createStripePaymentProviderAdapter(config.stripe);
  }
  if (provider === PaymentProvider.WECHAT_PAY && config.wechatPay) {
    return createWeChatPayPaymentProviderAdapter(config.wechatPay);
  }
  if (provider === PaymentProvider.ALIPAY && config.alipay) {
    return createAlipayPaymentProviderAdapter(config.alipay);
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

function normalizeStripeEventType(
  eventType: string,
  object: Record<string, unknown>,
): PaymentProviderEventType {
  if (eventType === "checkout.session.completed") {
    return object.payment_status === "paid"
      ? PaymentProviderEventType.RECHARGE_PAID
      : PaymentProviderEventType.UNKNOWN;
  }
  if (
    eventType === "checkout.session.async_payment_succeeded"
  ) {
    return PaymentProviderEventType.RECHARGE_PAID;
  }
  if (
    eventType === "checkout.session.async_payment_failed"
  ) {
    return PaymentProviderEventType.RECHARGE_FAILED;
  }
  return PaymentProviderEventType.UNKNOWN;
}

function createSignedWalletPaymentProviderAdapter(
  provider: PaymentProvider,
  providerName: "wechat_pay" | "alipay",
  config: SignedWalletProviderConfig,
): PaymentProviderAdapter {
  return {
    provider,
    ...(config.prepareRechargeCheckout
      ? {
          async prepareRechargeCheckout(input: RechargeCheckoutInput) {
            validateRechargeCheckoutInput(input);
            const rawPayload =
              await config.prepareRechargeCheckout!(input);
            return {
              provider: providerName,
              appId: config.appId,
              merchantId: config.merchantId,
              rawPayload: toJsonValue(rawPayload),
            };
          },
        }
      : {}),
    async createRechargeCheckout(input) {
      if (!config.createRechargeCheckout) {
        throw new Error(`${provider} checkout creation requires an official provider SDK adapter.`);
      }
      validateRechargeCheckoutInput(input);
      const preparedProviderPayload =
        readPreparedSignedWalletPayload(
          input.preparedProviderPayload,
          providerName,
          config,
        );
      const checkout = await config.createRechargeCheckout({
        ...input,
        ...(preparedProviderPayload
          ? { preparedProviderPayload }
          : {}),
      });
      return {
        provider,
        providerOrderId: checkout.providerOrderId,
        checkoutUrl: checkout.checkoutUrl ?? null,
        providerPayload: {
          provider: providerName,
          appId: config.appId,
          merchantId: config.merchantId,
          providerOrderId: checkout.providerOrderId,
          rawPayload: toJsonValue(checkout.rawPayload ?? {}),
        },
      };
    },
    async normalizeWebhookEvent(input) {
      if (!config.verifyAndParseWebhook) {
        throw new Error(`${provider} webhooks require signature verification before parsing.`);
      }
      const verification = await config.verifyAndParseWebhook(input);
      const parsed = requireVerifiedWebhookPayload(verification, provider);
      return normalizeSignedWalletPaymentEvent(
        provider,
        providerName,
        parsed,
        verification.verified ? verification.rawPayload : undefined,
        verification.verified ? verification.verifiedAt : undefined,
      );
    },
  };
}

function validateRechargeCheckoutInput(
  input: RechargeCheckoutInput,
): void {
  assertPositiveInteger(input.amountCents, "amountCents");
  assertSupportedCurrency(input.currency);
  requiredString(input.externalUserId, "externalUserId");
  requiredString(input.idempotencyKey, "idempotencyKey");
}

function readPreparedSignedWalletPayload(
  value: unknown,
  providerName: "wechat_pay" | "alipay",
  config: SignedWalletProviderConfig,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const outer = readGenericObject(
    value,
    "prepared payment provider payload",
  );
  if (
    outer.provider !== providerName
    || outer.appId !== config.appId
    || outer.merchantId !== config.merchantId
  ) {
    throw new Error(
      "Prepared payment provider payload does not match the configured provider identity.",
    );
  }
  return readGenericObject(
    outer.rawPayload,
    "prepared payment provider raw payload",
  );
}

function readGenericObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeSignedWalletPaymentEvent(
  provider: PaymentProvider,
  providerName: "wechat_pay" | "alipay",
  payload: Record<string, unknown>,
  rawPayload?: Record<string, unknown>,
  verifiedAt?: Date,
): NormalizedPaymentProviderEvent {
  const providerEventId = requiredString(
    payload.providerEventId ?? payload.transactionId ?? payload.tradeNo,
    "providerEventId",
  );
  const providerTransactionId =
    optionalString(payload.transactionId ?? payload.tradeNo) ?? null;
  const rechargeOrderId = requiredString(payload.rechargeOrderId, "rechargeOrderId");
  const providerOrderId = requiredString(
    payload.providerOrderId ?? payload.outTradeNo,
    "providerOrderId",
  );
  const amountCents = Number(payload.amountCents ?? payload.totalAmountCents);
  assertPositiveInteger(amountCents, "amountCents");
  const currency = requiredString(payload.currency, "currency").toUpperCase();
  assertSupportedCurrency(currency);
  const status = requiredString(payload.status ?? payload.tradeStatus, "status").toLowerCase();
  const eventType =
    status === "success" ||
    status === "paid" ||
    status === "trade_success" ||
    status === "transaction_success"
      ? PaymentProviderEventType.RECHARGE_PAID
      : status === "refund" || status === "refunded"
        ? PaymentProviderEventType.REFUND_SUCCEEDED
        : status === "failed" || status === "closed"
          ? PaymentProviderEventType.RECHARGE_FAILED
          : PaymentProviderEventType.UNKNOWN;
  const providerOccurredAt = parseOptionalProviderOccurredAt(
    payload.successTime,
  );

  return {
    provider,
    providerEventId,
    providerTransactionId,
    eventType,
    rechargeOrderId,
    providerOrderId,
    amountCents,
    currency,
    rawPayload: toJsonValue(rawPayload ?? payload),
    normalizedPayload: {
      type:
        eventType === PaymentProviderEventType.RECHARGE_PAID
          ? "RechargePaid"
          : eventType === PaymentProviderEventType.REFUND_SUCCEEDED
            ? "RechargeRefunded"
            : eventType === PaymentProviderEventType.RECHARGE_FAILED
              ? "RechargeFailed"
              : "PaymentProviderEvent",
      provider: providerName,
      rechargeOrderId,
      providerOrderId,
      providerTransactionId,
      amountCents,
      currency,
      providerOccurredAt:
        providerOccurredAt?.toISOString() ?? null,
    },
    idempotencyKey: `${providerName}:${providerEventId}`,
    verifiedAt: verifiedAt ?? null,
    ...(providerOccurredAt ? { providerOccurredAt } : {}),
  };
}

function parseOptionalProviderOccurredAt(
  value: unknown,
): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      value,
    )
  ) {
    throw new Error(
      "Signed wallet payment successTime must be a canonical ISO timestamp.",
    );
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== value
  ) {
    throw new Error(
      "Signed wallet payment successTime must be a valid timestamp.",
    );
  }
  return parsed;
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
  for (const key of ["amount_total", "amount_received", "amount"]) {
    const value = object[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  const metadataAmount = Number(metadata.amountCents);
  if (Number.isInteger(metadataAmount) && metadataAmount > 0) {
    return metadataAmount;
  }
  return null;
}

function readStripeCurrency(
  object: Record<string, unknown>,
  metadata: Record<string, string>,
): string | null {
  const objectCurrency = optionalString(object.currency);
  if (objectCurrency) {
    return objectCurrency.toUpperCase();
  }
  const metadataCurrency = optionalString(metadata.currency);
  return metadataCurrency ? metadataCurrency.toUpperCase() : null;
}

function requireVerifiedWebhookPayload(
  verification: PaymentProviderWebhookVerification,
  provider: string,
): Record<string, unknown> {
  if (verification?.verified !== true) {
    throw new PaymentProviderWebhookVerificationError(provider);
  }
  if (
    typeof verification.payload !== "object" ||
    verification.payload === null ||
    Array.isArray(verification.payload)
  ) {
    throw new Error(`${provider} verified webhook payload must be an object.`);
  }
  return verification.payload;
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
