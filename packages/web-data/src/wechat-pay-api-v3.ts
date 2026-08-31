import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { isIP } from "node:net";

import {
  PaymentProvider,
  PaymentProviderEventType,
} from "@prisma/client";

import {
  createWeChatPayPaymentProviderAdapter,
  type NormalizedPaymentProviderEvent,
  type PaymentProviderAdapter,
  type PaymentProviderWebhookInput,
  type PaymentProviderWebhookVerification,
  type RechargeCheckoutInput,
  type SignedWalletCheckoutRecord,
  type SignedWalletProviderConfig,
} from "./agent-wallet-payment-providers";

const NATIVE_ORDER_PATH = "/v3/pay/transactions/native";
const ORDER_QUERY_PATH_PREFIX =
  "/v3/pay/transactions/out-trade-no/";
const ORDER_CLOSE_PATH_SUFFIX = "/close";
const DOMESTIC_REFUND_PATH = "/v3/refund/domestic/refunds";
const SECURITY_ECHO_PATH = "/v3/security/echo";
const PUBLIC_KEY_PROBE_ECHO_MESSAGE =
  "delegate-wechat-pay-public-key-probe";
const PAYMENT_NOTIFICATION_PATH =
  "/api/payments/wechat/notify";
const REFUND_NOTIFICATION_PATH =
  "/api/payments/wechat/refund-notify";
const DEFAULT_API_BASE_URL = "https://api.mch.weixin.qq.com";
const DEFAULT_SIGNATURE_AGE_SECONDS = 5 * 60;
const DEFAULT_CHECKOUT_LIFETIME_SECONDS = 2 * 60 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const AUTH_SCHEME = "WECHATPAY2-SHA256-RSA2048";
const ENCRYPTION_ALGORITHM = "AEAD_AES_256_GCM";

export type WeChatPayApiV3Config = {
  appId: string;
  merchantId: string;
  merchantCertificateSerialNumber: string;
  merchantPrivateKey: string;
  apiV3Key: string;
  /**
   * Maps Wechatpay-Serial values to the matching WeChat Pay public key or
   * legacy platform certificate PEM. Keeping a map permits safe key rotation.
   */
  wechatPayVerificationKeys: Readonly<Record<string, string>>;
  /**
   * Requests that WeChat sign API responses with this configured key id.
   * Public-key migrations require sending the PUB_KEY_ID value on every
   * request so the merchant-console response rollout can advance.
   */
  wechatPaySerial: string;
  notifyUrl: string;
  refundNotifyUrl?: string;
  description?: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  nonce?: () => string;
  maxSignatureAgeSeconds?: number;
  checkoutLifetimeSeconds?: number;
  requestTimeoutMs?: number;
};

/**
 * Narrow configuration for the official WeChat Pay security echo endpoint.
 * It intentionally does not require an AppID, API v3 key, callback URL, or
 * release flag because the probe creates no order, callback, or ledger write.
 */
export type WeChatPayPublicKeyProbeConfig = {
  merchantId: string;
  merchantCertificateSerialNumber: string;
  merchantPrivateKey: string;
  publicKeyId: string;
  publicKey: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  nonce?: () => string;
  maxSignatureAgeSeconds?: number;
  requestTimeoutMs?: number;
};

export type WeChatPayPublicKeyProbeResult = {
  status: "verified";
  requestVerificationMode: "public_key";
  responseVerificationMode: "public_key";
  verifiedAt: string;
};

export type WeChatPayEnvironment =
  Readonly<Record<string, string | undefined>>;

type ResolvedRequestConfig = {
  merchantId: string;
  merchantCertificateSerialNumber: string;
  merchantPrivateKey: string;
  wechatPayVerificationKeys: Readonly<Record<string, string>>;
  wechatPaySerial: string;
  apiBaseUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  nonce: () => string;
  maxSignatureAgeSeconds: number;
  requestTimeoutMs: number;
};

type ResolvedConfig = ResolvedRequestConfig & {
  readonly resolved: true;
  appId: string;
  apiV3Key: string;
  notifyUrl: string;
  refundNotifyUrl: string;
  description: string;
  checkoutLifetimeSeconds: number;
};

type EncryptedResource = {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  associatedData: string;
  originalType: string;
};

type VerifiedDecryptedNotification = {
  eventId: string;
  eventType: string;
  resourceType: string;
  createTime: string | undefined;
  summary: string | undefined;
  resource: EncryptedResource;
  decryptedResource: Record<string, unknown>;
  verifiedAt: Date;
};

export type WeChatPayOrderQueryResult =
  | {
      status: "paid";
      tradeState: "SUCCESS";
      event: NormalizedPaymentProviderEvent;
    }
  | {
      status: "pending" | "closed" | "refunded" | "failed";
      tradeState:
        | "REFUND"
        | "NOTPAY"
        | "CLOSED"
        | "REVOKED"
        | "USERPAYING"
        | "PAYERROR";
      event: null;
    }
  | {
      status: "not_found";
      tradeState: null;
      event: null;
    };

export type NormalizedWeChatPayRefundResult = {
  provider: typeof PaymentProvider.WECHAT_PAY;
  providerEventId: string;
  refundId: string;
  outRefundNo: string;
  outTradeNo: string;
  transactionId: string;
  merchantId: string;
  refundStatus: "SUCCESS" | "CLOSED" | "ABNORMAL";
  originalAmountCents: number;
  refundAmountCents: number;
  payerAmountCents: number;
  payerRefundAmountCents: number;
  idempotencyKey: string;
  verifiedAt: Date;
  providerOccurredAt: Date;
  rawPayload: {
    id: string;
    createTime: string;
    resourceType: "encrypt-resource";
    eventType:
      | "REFUND.SUCCESS"
      | "REFUND.CLOSED"
      | "REFUND.ABNORMAL";
    summary: string;
    resource: {
      algorithm: typeof ENCRYPTION_ALGORITHM;
      ciphertext: string;
      nonce: string;
      associatedData: string;
      originalType: "refund";
    };
  };
  normalizedPayload: {
    type:
      | "RechargeRefunded"
      | "RechargeRefundClosed"
      | "RechargeRefundAbnormal";
    provider: "wechat_pay";
    providerEventId: string;
    providerRefundId: string;
    providerRefundOrderId: string;
    providerPaymentTransactionId: string;
    rechargeOrderId: string;
    merchantId: string;
    refundStatus: "SUCCESS" | "CLOSED" | "ABNORMAL";
    originalAmountCents: number;
    refundAmountCents: number;
    payerAmountCents: number;
    payerRefundAmountCents: number;
    providerOccurredAt: string;
  };
};

export type WeChatPayRefundApiStatus =
  | "PROCESSING"
  | "SUCCESS"
  | "CLOSED"
  | "ABNORMAL";

export type WeChatPayRefundApiResult = {
  source: "submission_response" | "refund_query";
  providerEventId: string;
  refundId: string;
  outRefundNo: string;
  outTradeNo: string;
  transactionId: string;
  refundStatus: WeChatPayRefundApiStatus;
  originalAmountCents: number;
  refundAmountCents: number;
  payerAmountCents: number;
  payerRefundAmountCents: number;
  verifiedAt: Date;
  providerCreatedAt: Date;
  providerOccurredAt: Date;
  rawPayload: {
    source: "submission_response" | "refund_query";
    refundId: string;
    outRefundNo: string;
    outTradeNo: string;
    transactionId: string;
    refundStatus: WeChatPayRefundApiStatus;
    createTime: string;
    successTime: string | null;
    amount: {
      total: number;
      refund: number;
      payerTotal: number;
      payerRefund: number;
      currency: "CNY";
    };
  };
  normalizedPayload: {
    type:
      | "RechargeRefundProcessing"
      | "RechargeRefunded"
      | "RechargeRefundClosed"
      | "RechargeRefundAbnormal";
    source: "submission_response" | "refund_query";
    provider: "wechat_pay";
    providerEventId: string;
    providerRefundId: string;
    providerRefundOrderId: string;
    providerPaymentTransactionId: string;
    rechargeOrderId: string;
    refundStatus: WeChatPayRefundApiStatus;
    originalAmountCents: number;
    refundAmountCents: number;
    payerAmountCents: number;
    payerRefundAmountCents: number;
    providerCreatedAt: string;
    providerOccurredAt: string;
  };
};

export type SubmitWeChatPayRefundInput = {
  transactionId: string;
  outTradeNo: string;
  outRefundNo: string;
  originalAmountCents: number;
  refundAmountCents: number;
  currency: "CNY";
  reason?: string;
  notifyUrl?: string;
};

export class WeChatPayConfigurationError extends Error {
  readonly code = "WECHAT_PAY_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WeChatPayConfigurationError";
  }
}

export class WeChatPayProtocolError extends Error {
  readonly code = "WECHAT_PAY_PROTOCOL_ERROR";
  readonly providerErrorCode: string | null;
  readonly providerHttpStatus: number | null;
  readonly providerRequestId: string | null;

  constructor(
    message: string,
    details: {
      providerErrorCode?: string | null;
      providerHttpStatus?: number | null;
      providerRequestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "WeChatPayProtocolError";
    this.providerErrorCode = normalizeProviderDiagnosticText(
      details.providerErrorCode,
      64,
    );
    this.providerHttpStatus =
      Number.isInteger(details.providerHttpStatus)
        ? details.providerHttpStatus ?? null
        : null;
    this.providerRequestId = normalizeProviderDiagnosticText(
      details.providerRequestId,
      128,
    );
  }
}

export class WeChatPayRefundApiError extends WeChatPayProtocolError {
  constructor(
    message: string,
    readonly failureKind:
      | "unknown"
      | "retryable"
      | "rejected"
      | "not_found",
    readonly providerCode: string,
    readonly httpStatus: number,
  ) {
    super(message, {
      providerErrorCode: providerCode,
      providerHttpStatus: httpStatus,
    });
    this.name = "WeChatPayRefundApiError";
  }
}

export function isWeChatPayApiV3Enabled(
  env: WeChatPayEnvironment = process.env,
): boolean {
  return env.DELEGATE_WECHAT_PAY_ENABLED === "true";
}

/**
 * Reads credentials only on the server. Multiline PEM values may be supplied
 * as base64 so they survive common deployment environment stores.
 */
export function loadWeChatPayApiV3ConfigFromEnv(
  env: WeChatPayEnvironment = process.env,
): WeChatPayApiV3Config {
  if (!isWeChatPayApiV3Enabled(env)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay is disabled. Set DELEGATE_WECHAT_PAY_ENABLED=true to enable it.",
    );
  }

  const appId = requiredEnvironmentText(
    env.WECHAT_PAY_APP_ID,
    "WECHAT_PAY_APP_ID",
  );
  const merchantId = requiredEnvironmentText(
    env.WECHAT_PAY_MERCHANT_ID,
    "WECHAT_PAY_MERCHANT_ID",
  );
  const merchantCertificateSerialNumber = requiredEnvironmentText(
    env.WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER,
    "WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER",
  );
  const merchantPrivateKey = requiredPemEnvironmentValue(
    env.WECHAT_PAY_MERCHANT_PRIVATE_KEY,
    env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64,
    "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
  );
  const apiV3Key = requiredEnvironmentText(
    env.WECHAT_PAY_API_V3_KEY,
    "WECHAT_PAY_API_V3_KEY",
  );
  const verificationKeys = parseVerificationKeyMap(
    env.WECHAT_PAY_VERIFICATION_KEYS_JSON,
  );
  const publicKeyId = optionalText(env.WECHAT_PAY_PUBLIC_KEY_ID);
  if (publicKeyId && !isWeChatPayPublicKeyId(publicKeyId)) {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_PUBLIC_KEY_ID must start with PUB_KEY_ID_ and contain digits after the prefix.",
    );
  }
  addEnvironmentVerificationKeyPair(verificationKeys, {
    keyId: publicKeyId,
    keyPem: readPemEnvironmentValue(
      env.WECHAT_PAY_PUBLIC_KEY,
      env.WECHAT_PAY_PUBLIC_KEY_BASE64,
    ),
    keyIdLabel: "WECHAT_PAY_PUBLIC_KEY_ID",
    keyPemLabel:
      "WECHAT_PAY_PUBLIC_KEY/WECHAT_PAY_PUBLIC_KEY_BASE64",
  });
  const platformCertificateSerialInput = optionalText(
    env.WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER,
  );
  if (
    platformCertificateSerialInput
    && !isPlatformCertificateSerial(platformCertificateSerialInput)
  ) {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER must be hexadecimal.",
    );
  }
  const platformCertificateSerial =
    platformCertificateSerialInput?.toUpperCase();
  addEnvironmentVerificationKeyPair(verificationKeys, {
    keyId: platformCertificateSerial,
    keyPem: readPemEnvironmentValue(
      env.WECHAT_PAY_PLATFORM_CERTIFICATE,
      env.WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64,
    ),
    keyIdLabel: "WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER",
    keyPemLabel:
      "WECHAT_PAY_PLATFORM_CERTIFICATE/WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64",
  });
  const wechatPaySerial = selectOutboundWechatPaySerial({
    verificationKeys,
    publicKeyId,
    platformCertificateSerial,
  });

  const description = optionalText(env.WECHAT_PAY_ORDER_DESCRIPTION);
  return {
    appId,
    merchantId,
    merchantCertificateSerialNumber,
    merchantPrivateKey,
    apiV3Key,
    wechatPayVerificationKeys: verificationKeys,
    wechatPaySerial,
    notifyUrl: resolveWeChatPayNotifyUrlEnvironment(env),
    refundNotifyUrl:
      resolveWeChatPayRefundNotifyUrlEnvironment(env),
    ...(description ? { description } : {}),
  };
}

export function loadWeChatPayPublicKeyProbeConfigFromEnv(
  env: WeChatPayEnvironment = process.env,
): WeChatPayPublicKeyProbeConfig {
  return {
    merchantId: requiredEnvironmentText(
      env.WECHAT_PAY_MERCHANT_ID,
      "WECHAT_PAY_MERCHANT_ID",
    ),
    merchantCertificateSerialNumber: requiredEnvironmentText(
      env.WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER,
      "WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER",
    ),
    merchantPrivateKey: requiredPemEnvironmentValue(
      env.WECHAT_PAY_MERCHANT_PRIVATE_KEY,
      env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64,
      "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
    ),
    publicKeyId: requiredEnvironmentText(
      env.WECHAT_PAY_PUBLIC_KEY_ID,
      "WECHAT_PAY_PUBLIC_KEY_ID",
    ),
    publicKey: requiredPemEnvironmentValue(
      env.WECHAT_PAY_PUBLIC_KEY,
      env.WECHAT_PAY_PUBLIC_KEY_BASE64,
      "WECHAT_PAY_PUBLIC_KEY",
    ),
  };
}

/**
 * Calls WeChat Pay's official mutation-free signature verification endpoint.
 * Success proves that the merchant signature is accepted and that the exact
 * configured WeChat Pay public key verifies the response.
 */
export async function probeWeChatPayPublicKey(
  config: WeChatPayPublicKeyProbeConfig,
): Promise<WeChatPayPublicKeyProbeResult> {
  const resolved = resolvePublicKeyProbeConfig(config);
  const body = JSON.stringify({
    echo_message: PUBLIC_KEY_PROBE_ECHO_MESSAGE,
  });
  const { response, responseBody, verifiedAt } =
    await requestWeChatPayApiV3({
      method: "POST",
      canonicalPath: SECURITY_ECHO_PATH,
      body,
      config: resolved,
    });

  if (!response.ok) {
    throw new WeChatPayProtocolError(
      `WeChat Pay public-key probe was rejected with HTTP ${response.status}.`,
    );
  }
  const responseSerial = normalizeVerificationKeyId(
    requiredHeader(response.headers, "Wechatpay-Serial"),
  );
  if (responseSerial !== resolved.wechatPaySerial) {
    throw new WeChatPayProtocolError(
      "WeChat Pay public-key probe response did not use the configured public key.",
    );
  }
  if (
    requiredText(
      responseBody.echo_message,
      "security echo response.echo_message",
    ) !== PUBLIC_KEY_PROBE_ECHO_MESSAGE
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay public-key probe returned an unexpected echo message.",
    );
  }

  return {
    status: "verified",
    requestVerificationMode: "public_key",
    responseVerificationMode: "public_key",
    verifiedAt: verifiedAt.toISOString(),
  };
}

export function createWeChatPayApiV3PaymentProviderAdapter(
  config: WeChatPayApiV3Config,
): PaymentProviderAdapter {
  return createWeChatPayPaymentProviderAdapter(
    createWeChatPayApiV3SignedWalletProviderConfig(config),
  );
}

export function createWeChatPayApiV3SignedWalletProviderConfig(
  config: WeChatPayApiV3Config,
): SignedWalletProviderConfig {
  const resolved = resolveConfig(config);
  return {
    appId: resolved.appId,
    merchantId: resolved.merchantId,
    prepareRechargeCheckout: (input) =>
      Promise.resolve(
        prepareWeChatPayNativeCheckout(input, resolved),
      ),
    createRechargeCheckout: (input) =>
      createWeChatPayNativeCheckout(input, resolved),
    verifyAndParseWebhook: (input) =>
      verifyWeChatPayApiV3Notification(input, resolved),
  };
}

export async function createWeChatPayNativeCheckout(
  input: RechargeCheckoutInput,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<SignedWalletCheckoutRecord> {
  const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
  if (input.currency !== "CNY") {
    throw new WeChatPayProtocolError(
      "WeChat Pay Native recharge currently supports CNY only.",
    );
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const outTradeNo = requiredText(input.rechargeOrderId, "rechargeOrderId");
  assertValidOutTradeNo(outTradeNo);

  const prepared = input.preparedProviderPayload === undefined
    ? prepareWeChatPayNativeCheckout(input, resolved)
    : parsePreparedWeChatPayNativeCheckout(
        input.preparedProviderPayload,
        input,
        resolved,
      );
  const body = JSON.stringify({
    appid: prepared.appId,
    mchid: prepared.merchantId,
    description: prepared.description,
    out_trade_no: prepared.outTradeNo,
    time_expire: toRfc3339Seconds(
      new Date(prepared.expiresAt),
    ),
    notify_url: prepared.notifyUrl,
    amount: {
      total: prepared.amountCents,
      currency: prepared.currency,
    },
  });
  const { response, responseBody } = await requestWeChatPayApiV3({
    method: "POST",
    canonicalPath: NATIVE_ORDER_PATH,
    body,
    config: resolved,
  });
  if (!response.ok) {
    const providerCode = optionalText(responseBody.code) ?? "HTTP_ERROR";
    throw new WeChatPayProtocolError(
      `WeChat Pay Native order creation failed (${response.status}, ${providerCode}).`,
      {
        providerErrorCode: providerCode,
        providerHttpStatus: response.status,
        providerRequestId: readWeChatPayRequestId(response.headers),
      },
    );
  }
  const codeUrl = requiredText(responseBody.code_url, "code_url");
  if (!codeUrl.startsWith("weixin://wxpay/")) {
    throw new WeChatPayProtocolError(
      "WeChat Pay Native response returned an invalid code_url.",
    );
  }

  return {
    providerOrderId: outTradeNo,
    checkoutUrl: codeUrl,
    rawPayload: {
      mode: "native",
      outTradeNo,
      expiresAt: prepared.expiresAt,
    },
  };
}

function prepareWeChatPayNativeCheckout(
  input: RechargeCheckoutInput,
  config: ResolvedConfig,
): PreparedWeChatPayNativeCheckout {
  if (input.currency !== "CNY") {
    throw new WeChatPayProtocolError(
      "WeChat Pay Native recharge currently supports CNY only.",
    );
  }
  assertPositiveInteger(input.amountCents, "amountCents");
  const outTradeNo = requiredText(
    input.rechargeOrderId,
    "rechargeOrderId",
  );
  assertValidOutTradeNo(outTradeNo);
  const expiresAt = new Date(
    config.now().getTime()
      + config.checkoutLifetimeSeconds * 1000,
  );
  return {
    version: 1,
    mode: "native",
    appId: config.appId,
    merchantId: config.merchantId,
    description: config.description,
    outTradeNo,
    expiresAt: expiresAt.toISOString(),
    notifyUrl: config.notifyUrl,
    amountCents: input.amountCents,
    currency: input.currency,
  };
}

type PreparedWeChatPayNativeCheckout = {
  version: 1;
  mode: "native";
  appId: string;
  merchantId: string;
  description: string;
  outTradeNo: string;
  expiresAt: string;
  notifyUrl: string;
  amountCents: number;
  currency: "CNY";
};

function parsePreparedWeChatPayNativeCheckout(
  value: unknown,
  input: RechargeCheckoutInput,
  config: ResolvedConfig,
): PreparedWeChatPayNativeCheckout {
  const prepared = readObject(
    value,
    "prepared_native_checkout",
  );
  if (
    prepared.version !== 1
    || prepared.mode !== "native"
  ) {
    throw new WeChatPayProtocolError(
      "Prepared WeChat Pay Native checkout has an unsupported format.",
    );
  }
  const appId = requiredText(
    prepared.appId,
    "prepared_native_checkout.appId",
  );
  const merchantId = requiredText(
    prepared.merchantId,
    "prepared_native_checkout.merchantId",
  );
  const description = requiredText(
    prepared.description,
    "prepared_native_checkout.description",
  );
  const outTradeNo = requiredText(
    prepared.outTradeNo ?? prepared.out_trade_no,
    "prepared_native_checkout.outTradeNo",
  );
  const expiresAt = requiredCanonicalIsoTimestamp(
    prepared.expiresAt,
    "prepared_native_checkout.expiresAt",
  );
  const notifyUrl = parsePublicHttpsCallbackUrl(
    requiredText(
      prepared.notifyUrl,
      "prepared_native_checkout.notifyUrl",
    ),
    "prepared_native_checkout.notifyUrl",
    { requirePath: true },
  );
  const amountCents = Number(prepared.amountCents);
  assertPositiveInteger(
    amountCents,
    "prepared_native_checkout.amountCents",
  );
  const currency = requiredText(
    prepared.currency,
    "prepared_native_checkout.currency",
  ).toUpperCase();
  const inputOutTradeNo = requiredText(
    input.rechargeOrderId,
    "rechargeOrderId",
  );
  if (
    appId !== config.appId
    || merchantId !== config.merchantId
    || outTradeNo !== inputOutTradeNo
    || amountCents !== input.amountCents
    || currency !== input.currency
    || currency !== "CNY"
  ) {
    throw new WeChatPayProtocolError(
      "Prepared WeChat Pay Native checkout does not match the local order.",
    );
  }
  assertValidOutTradeNo(outTradeNo);
  return {
    version: 1,
    mode: "native",
    appId,
    merchantId,
    description,
    outTradeNo,
    expiresAt,
    notifyUrl,
    amountCents,
    currency: "CNY",
  };
}

export async function queryWeChatPayOrderByOutTradeNo(
  outTradeNoInput: string,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<WeChatPayOrderQueryResult> {
  const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
  const outTradeNo = requiredText(outTradeNoInput, "outTradeNo");
  assertValidOutTradeNo(outTradeNo);
  const canonicalPath =
    `${ORDER_QUERY_PATH_PREFIX}${encodeURIComponent(outTradeNo)}`
    + `?mchid=${encodeURIComponent(resolved.merchantId)}`;
  const { response, responseBody, verifiedAt } =
    await requestWeChatPayApiV3({
      method: "GET",
      canonicalPath,
      config: resolved,
    });
  if (!response.ok) {
    const providerCode = optionalText(responseBody.code) ?? "HTTP_ERROR";
    if (
      response.status === 404
      && (
        providerCode === "ORDER_NOT_EXIST"
        || providerCode === "NOT_FOUND"
      )
    ) {
      return {
        status: "not_found",
        tradeState: null,
        event: null,
      };
    }
    throw new WeChatPayProtocolError(
      `WeChat Pay order query failed (${response.status}, ${providerCode}).`,
      {
        providerErrorCode: providerCode,
        providerHttpStatus: response.status,
        providerRequestId: readWeChatPayRequestId(response.headers),
      },
    );
  }

  const appId = requiredText(responseBody.appid, "query.appid");
  const merchantId = requiredText(responseBody.mchid, "query.mchid");
  const responseOutTradeNo = requiredText(
    responseBody.out_trade_no,
    "query.out_trade_no",
  );
  if (
    appId !== resolved.appId
    || merchantId !== resolved.merchantId
    || responseOutTradeNo !== outTradeNo
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay order query identity does not match the request.",
    );
  }
  const tradeState = requiredText(
    responseBody.trade_state,
    "query.trade_state",
  );
  const hasTradeType = Object.prototype.hasOwnProperty.call(
    responseBody,
    "trade_type",
  );
  const tradeType = tradeState === "SUCCESS" || hasTradeType
    ? requiredText(responseBody.trade_type, "query.trade_type")
    : undefined;
  if (tradeType !== undefined && tradeType !== "NATIVE") {
    throw new WeChatPayProtocolError(
      "WeChat Pay order query is not a Native payment.",
    );
  }
  const amount = readObject(responseBody.amount, "query.amount");
  const amountCents = Number(amount.total);
  assertPositiveInteger(amountCents, "query.amount.total");
  const currency = requiredText(
    amount.currency,
    "query.amount.currency",
  ).toUpperCase();
  if (currency !== "CNY") {
    throw new WeChatPayProtocolError(
      "WeChat Pay order query currency must be CNY.",
    );
  }
  if (tradeState !== "SUCCESS") {
    if (!isUnpaidTradeState(tradeState)) {
      throw new WeChatPayProtocolError(
        "WeChat Pay order query returned an unsupported trade state.",
      );
    }
    return {
      status: mapUnpaidTradeState(tradeState),
      tradeState,
      event: null,
    };
  }

  const transactionId = requiredText(
    responseBody.transaction_id,
    "query.transaction_id",
  );
  const providerOccurredAt = parseWeChatPaySuccessTime(
    responseBody.success_time,
    "query.success_time",
  );
  const providerEventId = `query:${transactionId}`;
  const safeProviderPayload = {
    source: "order_query",
    appId,
    merchantId,
    outTradeNo,
    transactionId,
    tradeState,
    ...(tradeType ? { tradeType } : {}),
    successTime: providerOccurredAt.toISOString(),
    amount: {
      total: amountCents,
      currency,
    },
  };
  const event: NormalizedPaymentProviderEvent = {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId,
    providerTransactionId: transactionId,
    eventType: PaymentProviderEventType.RECHARGE_PAID,
    rechargeOrderId: outTradeNo,
    providerOrderId: outTradeNo,
    amountCents,
    currency,
    rawPayload: safeProviderPayload,
    normalizedPayload: {
      type: "RechargePaid",
      provider: "wechat_pay",
      rechargeOrderId: outTradeNo,
      providerOrderId: outTradeNo,
      providerTransactionId: transactionId,
      amountCents,
      currency,
    },
    idempotencyKey: `wechat_pay:${providerEventId}`,
    verifiedAt,
    providerOccurredAt,
  };
  return {
    status: "paid",
    tradeState,
    event,
  };
}

export async function closeWeChatPayOrderByOutTradeNo(
  outTradeNoInput: string,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<void> {
  const resolved = isResolvedConfig(config)
    ? config
    : resolveConfig(config);
  const outTradeNo = requiredText(
    outTradeNoInput,
    "outTradeNo",
  );
  assertValidOutTradeNo(outTradeNo);
  const canonicalPath =
    `${ORDER_QUERY_PATH_PREFIX}${encodeURIComponent(outTradeNo)}`
    + ORDER_CLOSE_PATH_SUFFIX;
  const body = JSON.stringify({ mchid: resolved.merchantId });
  const { response, responseBody } =
    await requestWeChatPayApiV3({
      method: "POST",
      canonicalPath,
      body,
      config: resolved,
    });
  if (response.status !== 204) {
    const providerCode =
      optionalText(responseBody.code) ?? "HTTP_ERROR";
    throw new WeChatPayProtocolError(
      `WeChat Pay order close failed (${response.status}, ${providerCode}).`,
    );
  }
}

export async function submitWeChatPayRefund(
  input: SubmitWeChatPayRefundInput,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<WeChatPayRefundApiResult> {
  const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
  const transactionId = requiredBoundedText(
    input.transactionId,
    "refund.transactionId",
    32,
  );
  const outTradeNo = requiredBoundedText(
    input.outTradeNo,
    "refund.outTradeNo",
    32,
  );
  assertValidOutTradeNo(outTradeNo);
  const outRefundNo = requiredBoundedText(
    input.outRefundNo,
    "refund.outRefundNo",
    64,
  );
  assertValidOutRefundNo(outRefundNo);
  assertPositiveInteger(
    input.originalAmountCents,
    "refund.originalAmountCents",
  );
  assertPositiveInteger(
    input.refundAmountCents,
    "refund.refundAmountCents",
  );
  if (input.refundAmountCents > input.originalAmountCents) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund amount cannot exceed the original amount.",
    );
  }
  if (input.currency !== "CNY") {
    throw new WeChatPayProtocolError(
      "WeChat Pay domestic refunds currently support CNY only.",
    );
  }
  const reason = optionalText(input.reason);
  if (reason) {
    assertTextByteLength(reason, "refund.reason", 80);
  }
  const notifyUrl = parsePublicHttpsCallbackUrl(
    input.notifyUrl ?? resolved.refundNotifyUrl,
    "refund.notifyUrl",
    { requirePath: true },
  );
  const body = JSON.stringify({
    transaction_id: transactionId,
    out_refund_no: outRefundNo,
    ...(reason ? { reason } : {}),
    notify_url: notifyUrl,
    amount: {
      refund: input.refundAmountCents,
      total: input.originalAmountCents,
      currency: input.currency,
    },
  });
  const { response, responseBody, verifiedAt } =
    await requestWeChatPayApiV3({
      method: "POST",
      canonicalPath: DOMESTIC_REFUND_PATH,
      body,
      config: resolved,
    });
  if (!response.ok) {
    throw refundApiResponseError(
      "submission",
      response.status,
      responseBody,
    );
  }
  const result = parseWeChatPayRefundApiResponse(
    responseBody,
    "submission_response",
    verifiedAt,
  );
  assertWeChatPayRefundApiIdentity(result, {
    transactionId,
    outTradeNo,
    outRefundNo,
    originalAmountCents: input.originalAmountCents,
    refundAmountCents: input.refundAmountCents,
    currency: input.currency,
  });
  return result;
}

export async function queryWeChatPayRefundByOutRefundNo(
  outRefundNoInput: string,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<WeChatPayRefundApiResult> {
  const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
  const outRefundNo = requiredBoundedText(
    outRefundNoInput,
    "refund.outRefundNo",
    64,
  );
  assertValidOutRefundNo(outRefundNo);
  const canonicalPath =
    `${DOMESTIC_REFUND_PATH}/${encodeURIComponent(outRefundNo)}`;
  const { response, responseBody, verifiedAt } =
    await requestWeChatPayApiV3({
      method: "GET",
      canonicalPath,
      config: resolved,
    });
  if (!response.ok) {
    throw refundApiResponseError(
      "query",
      response.status,
      responseBody,
    );
  }
  const result = parseWeChatPayRefundApiResponse(
    responseBody,
    "refund_query",
    verifiedAt,
  );
  if (result.outRefundNo !== outRefundNo) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund query identity does not match the request.",
    );
  }
  return result;
}

function parseWeChatPayRefundApiResponse(
  response: Record<string, unknown>,
  source: WeChatPayRefundApiResult["source"],
  verifiedAt: Date,
): WeChatPayRefundApiResult {
  const refundId = requiredBoundedText(
    response.refund_id,
    "refund_response.refund_id",
    32,
  );
  const outRefundNo = requiredBoundedText(
    response.out_refund_no,
    "refund_response.out_refund_no",
    64,
  );
  assertValidOutRefundNo(outRefundNo);
  const transactionId = requiredBoundedText(
    response.transaction_id,
    "refund_response.transaction_id",
    32,
  );
  const outTradeNo = requiredBoundedText(
    response.out_trade_no,
    "refund_response.out_trade_no",
    32,
  );
  assertValidOutTradeNo(outTradeNo);
  const refundStatus = requiredBoundedText(
    response.status,
    "refund_response.status",
    32,
  );
  if (!isWeChatPayRefundApiStatus(refundStatus)) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund response returned an unsupported status.",
    );
  }
  const createTimeText = requiredBoundedText(
    response.create_time,
    "refund_response.create_time",
    64,
  );
  const providerCreatedAt = parseWeChatPaySuccessTime(
    createTimeText,
    "refund_response.create_time",
  );
  const successTimeText = optionalText(response.success_time);
  if (successTimeText) {
    assertTextByteLength(
      successTimeText,
      "refund_response.success_time",
      64,
    );
  }
  const providerOccurredAt =
    refundStatus === "SUCCESS"
      ? parseWeChatPaySuccessTime(
          requiredBoundedText(
            response.success_time,
            "refund_response.success_time",
            64,
          ),
          "refund_response.success_time",
        )
      : successTimeText
        ? parseWeChatPaySuccessTime(
            successTimeText,
            "refund_response.success_time",
          )
        : providerCreatedAt;

  // Validate this provider-required field, but never expose or persist it.
  requiredBoundedText(
    response.user_received_account,
    "refund_response.user_received_account",
    64,
  );
  const amount = readObject(
    response.amount,
    "refund_response.amount",
  );
  const originalAmountCents = readPositiveSafeInteger(
    amount.total,
    "refund_response.amount.total",
  );
  const refundAmountCents = readPositiveSafeInteger(
    amount.refund,
    "refund_response.amount.refund",
  );
  const payerAmountCents = readNonNegativeSafeInteger(
    amount.payer_total,
    "refund_response.amount.payer_total",
  );
  const payerRefundAmountCents = readNonNegativeSafeInteger(
    amount.payer_refund,
    "refund_response.amount.payer_refund",
  );
  const currency = requiredBoundedText(
    amount.currency,
    "refund_response.amount.currency",
    3,
  ).toUpperCase();
  if (
    currency !== "CNY"
    || refundAmountCents > originalAmountCents
    || payerAmountCents > originalAmountCents
    || payerRefundAmountCents > payerAmountCents
    || payerRefundAmountCents > refundAmountCents
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund response amounts are inconsistent.",
    );
  }
  const providerEventId =
    `${source}:${refundId}:${refundStatus}:`
    + (
      refundStatus === "SUCCESS"
        ? providerOccurredAt.toISOString()
        : providerCreatedAt.toISOString()
    );
  const normalizedType:
    WeChatPayRefundApiResult["normalizedPayload"]["type"] =
      refundStatus === "PROCESSING"
        ? "RechargeRefundProcessing"
        : refundStatus === "SUCCESS"
          ? "RechargeRefunded"
          : refundStatus === "CLOSED"
            ? "RechargeRefundClosed"
            : "RechargeRefundAbnormal";
  const rawPayload: WeChatPayRefundApiResult["rawPayload"] = {
    source,
    refundId,
    outRefundNo,
    outTradeNo,
    transactionId,
    refundStatus,
    createTime: providerCreatedAt.toISOString(),
    successTime:
      refundStatus === "SUCCESS"
        ? providerOccurredAt.toISOString()
        : null,
    amount: {
      total: originalAmountCents,
      refund: refundAmountCents,
      payerTotal: payerAmountCents,
      payerRefund: payerRefundAmountCents,
      currency: "CNY",
    },
  };
  return {
    source,
    providerEventId,
    refundId,
    outRefundNo,
    outTradeNo,
    transactionId,
    refundStatus,
    originalAmountCents,
    refundAmountCents,
    payerAmountCents,
    payerRefundAmountCents,
    verifiedAt,
    providerCreatedAt,
    providerOccurredAt,
    rawPayload,
    normalizedPayload: {
      type: normalizedType,
      source,
      provider: "wechat_pay",
      providerEventId,
      providerRefundId: refundId,
      providerRefundOrderId: outRefundNo,
      providerPaymentTransactionId: transactionId,
      rechargeOrderId: outTradeNo,
      refundStatus,
      originalAmountCents,
      refundAmountCents,
      payerAmountCents,
      payerRefundAmountCents,
      providerCreatedAt: providerCreatedAt.toISOString(),
      providerOccurredAt: providerOccurredAt.toISOString(),
    },
  };
}

function assertWeChatPayRefundApiIdentity(
  result: WeChatPayRefundApiResult,
  expected: {
    transactionId: string;
    outTradeNo: string;
    outRefundNo: string;
    originalAmountCents: number;
    refundAmountCents: number;
    currency: "CNY";
  },
): void {
  if (
    result.transactionId !== expected.transactionId
    || result.outTradeNo !== expected.outTradeNo
    || result.outRefundNo !== expected.outRefundNo
    || result.originalAmountCents !== expected.originalAmountCents
    || result.refundAmountCents !== expected.refundAmountCents
    || result.rawPayload.amount.currency !== expected.currency
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund response identity does not match the request.",
    );
  }
}

function refundApiResponseError(
  operation: "submission" | "query",
  httpStatus: number,
  response: Record<string, unknown>,
): WeChatPayRefundApiError {
  const providerCode = optionalText(response.code) ?? "HTTP_ERROR";
  const failureKind =
    operation === "query" && providerCode === "RESOURCE_NOT_EXISTS"
      ? "not_found"
      : providerCode === "SYSTEM_ERROR"
        || providerCode === "FREQUENCY_LIMITED"
        || httpStatus === 429
        || httpStatus >= 500
        ? "retryable"
        : "rejected";
  return new WeChatPayRefundApiError(
    `WeChat Pay refund ${operation} failed (${httpStatus}, ${providerCode}).`,
    failureKind,
    providerCode,
    httpStatus,
  );
}

function isWeChatPayRefundApiStatus(
  value: string,
): value is WeChatPayRefundApiStatus {
  return [
    "PROCESSING",
    "SUCCESS",
    "CLOSED",
    "ABNORMAL",
  ].includes(value);
}

export async function verifyWeChatPayApiV3Notification(
  input: PaymentProviderWebhookInput,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<PaymentProviderWebhookVerification> {
  try {
    const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
    const notification = verifyAndDecryptWeChatPayApiV3Notification(
      input,
      resolved,
    );
    const {
      eventId,
      eventType,
      resourceType,
      resource,
      decryptedResource: transaction,
      verifiedAt,
    } = notification;
    if (
      eventType !== "TRANSACTION.SUCCESS"
      || resourceType !== "encrypt-resource"
    ) {
      throw new WeChatPayProtocolError(
        "WeChat Pay notification is not a successful encrypted transaction.",
      );
    }
    if (resource.originalType !== "transaction") {
      throw new WeChatPayProtocolError(
        "WeChat Pay notification resource type is not a transaction.",
      );
    }

    const appId = requiredText(transaction.appid, "transaction.appid");
    const merchantId = requiredText(transaction.mchid, "transaction.mchid");
    if (appId !== resolved.appId || merchantId !== resolved.merchantId) {
      throw new WeChatPayProtocolError(
        "WeChat Pay notification merchant identity does not match configuration.",
      );
    }

    const outTradeNo = requiredText(
      transaction.out_trade_no,
      "transaction.out_trade_no",
    );
    const transactionId = requiredText(
      transaction.transaction_id,
      "transaction.transaction_id",
    );
    const providerOccurredAt = parseWeChatPaySuccessTime(
      transaction.success_time,
      "transaction.success_time",
    );
    const tradeState = requiredText(
      transaction.trade_state,
      "transaction.trade_state",
    );
    const tradeType = requiredText(
      transaction.trade_type,
      "transaction.trade_type",
    );
    if (tradeState !== "SUCCESS" || tradeType !== "NATIVE") {
      throw new WeChatPayProtocolError(
        "WeChat Pay notification does not match a successful Native payment.",
      );
    }
    const amount = readObject(transaction.amount, "transaction.amount");
    const amountCents = Number(amount.total);
    assertPositiveInteger(amountCents, "transaction.amount.total");
    const currency = requiredText(
      amount.currency,
      "transaction.amount.currency",
    ).toUpperCase();
    if (currency !== "CNY") {
      throw new WeChatPayProtocolError(
        "WeChat Pay notification currency must be CNY.",
      );
    }

    return {
      verified: true,
      verifiedAt,
      payload: {
        providerEventId: eventId,
        transactionId,
        rechargeOrderId: outTradeNo,
        providerOrderId: outTradeNo,
        amountCents,
        currency,
        status: tradeState,
        eventType,
        appId,
        merchantId,
        tradeType,
        successTime: providerOccurredAt.toISOString(),
      },
      // Keep encrypted evidence only. Decrypted payer fields such as openid and
      // bank_type are deliberately excluded from persistent provider events.
      rawPayload: {
        id: eventId,
        createTime: notification.createTime ?? null,
        resourceType,
        eventType,
        summary: notification.summary ?? null,
        resource: {
          algorithm: resource.algorithm,
          ciphertext: resource.ciphertext,
          nonce: resource.nonce,
          associatedData: resource.associatedData,
          originalType: resource.originalType,
        },
      },
    };
  } catch {
    return {
      verified: false,
      reason: "WeChat Pay notification verification failed.",
    };
  }
}

export async function verifyWeChatPayApiV3RefundNotification(
  input: PaymentProviderWebhookInput,
  config: WeChatPayApiV3Config | ResolvedConfig,
): Promise<NormalizedWeChatPayRefundResult> {
  const resolved = isResolvedConfig(config) ? config : resolveConfig(config);
  const notification = verifyAndDecryptWeChatPayApiV3Notification(
    input,
    resolved,
  );
  const eventRefundStatus =
    notification.eventType === "REFUND.SUCCESS"
      ? "SUCCESS"
      : notification.eventType === "REFUND.CLOSED"
        ? "CLOSED"
        : notification.eventType === "REFUND.ABNORMAL"
          ? "ABNORMAL"
          : null;
  if (!eventRefundStatus) {
    throw new WeChatPayProtocolError(
      "WeChat Pay notification is not a supported refund status change.",
    );
  }
  if (notification.resourceType !== "encrypt-resource") {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund notification is not encrypted.",
    );
  }
  if (notification.resource.originalType !== "refund") {
    throw new WeChatPayProtocolError(
      "WeChat Pay notification resource type is not a refund.",
    );
  }

  const providerEventId = requiredBoundedText(
    notification.eventId,
    "notification.id",
    36,
  );
  const createTime = requiredBoundedText(
    notification.createTime,
    "notification.create_time",
    32,
  );
  const notificationOccurredAt = parseWeChatPaySuccessTime(
    createTime,
    "notification.create_time",
  );
  const summary = requiredBoundedText(
    notification.summary,
    "notification.summary",
    16,
  );
  assertTextByteLength(
    notification.resource.algorithm,
    "notification.resource.algorithm",
    32,
  );
  assertTextByteLength(
    notification.resource.originalType,
    "notification.resource.original_type",
    32,
  );
  assertTextByteLength(
    notification.resource.ciphertext,
    "notification.resource.ciphertext",
    1_048_576,
  );
  assertTextByteLength(
    notification.resource.nonce,
    "notification.resource.nonce",
    32,
  );
  assertTextByteLength(
    notification.resource.associatedData,
    "notification.resource.associated_data",
    16,
  );

  const refund = notification.decryptedResource;
  const merchantId = requiredBoundedText(
    refund.mchid,
    "refund.mchid",
    32,
  );
  if (merchantId !== resolved.merchantId) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund notification merchant identity does not match configuration.",
    );
  }
  const outTradeNo = requiredBoundedText(
    refund.out_trade_no,
    "refund.out_trade_no",
    32,
  );
  assertValidOutTradeNo(outTradeNo);
  const transactionId = requiredBoundedText(
    refund.transaction_id,
    "refund.transaction_id",
    32,
  );
  const outRefundNo = requiredBoundedText(
    refund.out_refund_no,
    "refund.out_refund_no",
    64,
  );
  assertValidOutRefundNo(outRefundNo);
  const refundId = requiredBoundedText(
    refund.refund_id,
    "refund.refund_id",
    32,
  );
  const refundStatus = requiredBoundedText(
    refund.refund_status,
    "refund.refund_status",
    32,
  );
  if (
    refundStatus !== "SUCCESS"
    && refundStatus !== "CLOSED"
    && refundStatus !== "ABNORMAL"
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund notification status is unsupported.",
    );
  }
  const terminalRefundStatus:
    NormalizedWeChatPayRefundResult["refundStatus"] =
      refundStatus === "SUCCESS"
        ? "SUCCESS"
        : refundStatus === "CLOSED"
          ? "CLOSED"
          : "ABNORMAL";
  if (terminalRefundStatus !== eventRefundStatus) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund envelope and resource statuses do not match.",
    );
  }
  const successTime = optionalText(refund.success_time);
  if (successTime) {
    assertTextByteLength(
      successTime,
      "refund.success_time",
      64,
    );
  }
  const providerOccurredAt =
    terminalRefundStatus === "SUCCESS"
      ? parseWeChatPaySuccessTime(
          requiredBoundedText(
            refund.success_time,
            "refund.success_time",
            64,
          ),
          "refund.success_time",
        )
      : successTime
        ? parseWeChatPaySuccessTime(
            successTime,
            "refund.success_time",
          )
        : notificationOccurredAt;
  // This field is mandatory in the provider contract. Validate it, but never
  // return it because it may reveal a user's bank or balance account.
  requiredBoundedText(
    refund.user_received_account,
    "refund.user_received_account",
    64,
  );

  const amount = readObject(refund.amount, "refund.amount");
  const originalAmountCents = readPositiveSafeInteger(
    amount.total,
    "refund.amount.total",
  );
  const refundAmountCents = readPositiveSafeInteger(
    amount.refund,
    "refund.amount.refund",
  );
  const payerAmountCents = readNonNegativeSafeInteger(
    amount.payer_total,
    "refund.amount.payer_total",
  );
  const payerRefundAmountCents = readNonNegativeSafeInteger(
    amount.payer_refund,
    "refund.amount.payer_refund",
  );
  if (
    refundAmountCents > originalAmountCents
    || payerAmountCents > originalAmountCents
    || payerRefundAmountCents > refundAmountCents
    || payerRefundAmountCents > payerAmountCents
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay refund notification amounts are inconsistent.",
    );
  }

  const rawPayload: NormalizedWeChatPayRefundResult["rawPayload"] = {
    id: providerEventId,
    createTime,
    resourceType: "encrypt-resource" as const,
    eventType: notification.eventType as
      NormalizedWeChatPayRefundResult["rawPayload"]["eventType"],
    summary,
    resource: {
      algorithm: ENCRYPTION_ALGORITHM,
      ciphertext: notification.resource.ciphertext,
      nonce: notification.resource.nonce,
      associatedData: notification.resource.associatedData,
      originalType: "refund" as const,
    },
  };
  const normalizedType:
    NormalizedWeChatPayRefundResult["normalizedPayload"]["type"] =
    terminalRefundStatus === "SUCCESS"
      ? "RechargeRefunded"
      : terminalRefundStatus === "CLOSED"
        ? "RechargeRefundClosed"
        : "RechargeRefundAbnormal";
  const normalizedPayload:
    NormalizedWeChatPayRefundResult["normalizedPayload"] = {
    type: normalizedType,
    provider: "wechat_pay" as const,
    providerEventId,
    providerRefundId: refundId,
    providerRefundOrderId: outRefundNo,
    providerPaymentTransactionId: transactionId,
    rechargeOrderId: outTradeNo,
    merchantId,
    refundStatus: terminalRefundStatus,
    originalAmountCents,
    refundAmountCents,
    payerAmountCents,
    payerRefundAmountCents,
    providerOccurredAt: providerOccurredAt.toISOString(),
  };

  return {
    provider: PaymentProvider.WECHAT_PAY,
    providerEventId,
    refundId,
    outRefundNo,
    outTradeNo,
    transactionId,
    merchantId,
    refundStatus: terminalRefundStatus,
    originalAmountCents,
    refundAmountCents,
    payerAmountCents,
    payerRefundAmountCents,
    idempotencyKey:
      `wechat_pay:refund_notification:${providerEventId}`,
    verifiedAt: notification.verifiedAt,
    providerOccurredAt,
    rawPayload,
    normalizedPayload,
  };
}

export function verifyWeChatPaySignedMessage(input: {
  rawBody: string;
  headers: Headers | Readonly<Record<string, string | undefined>>;
  verificationKeys: Readonly<Record<string, string>>;
  now?: Date;
  maxSignatureAgeSeconds?: number;
}): void {
  const timestampText = requiredHeader(
    input.headers,
    "Wechatpay-Timestamp",
  );
  const nonce = requiredHeader(input.headers, "Wechatpay-Nonce");
  const serial = normalizeVerificationKeyId(
    requiredHeader(input.headers, "Wechatpay-Serial"),
  );
  const signature = requiredHeader(input.headers, "Wechatpay-Signature");
  const signatureType = optionalHeader(
    input.headers,
    "Wechatpay-Signature-Type",
  );
  if (signatureType && signatureType !== AUTH_SCHEME) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature type is unsupported.",
    );
  }
  if (!/^\d{10}$/.test(timestampText)) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature timestamp is invalid.",
    );
  }
  if (
    !/^[0-9A-Za-z_-]{1,64}$/.test(nonce)
    || !/^[0-9A-Za-z_-]{1,128}$/.test(serial)
    || signature.length > 1024
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature header exceeds the accepted length.",
    );
  }
  const timestamp = Number(timestampText);
  const now = input.now ?? new Date();
  const maxAge =
    input.maxSignatureAgeSeconds
    ?? DEFAULT_SIGNATURE_AGE_SECONDS;
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > maxAge
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature timestamp is outside the accepted window.",
    );
  }
  const verificationKey = input.verificationKeys[serial];
  if (!verificationKey) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature key id is not configured.",
    );
  }
  if (!isCanonicalBase64(signature)) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature encoding is invalid.",
    );
  }
  const message = `${timestampText}\n${nonce}\n${input.rawBody}\n`;
  if (
    !verifySignature(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      verificationKey,
      Buffer.from(signature, "base64"),
    )
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay signature verification failed.",
    );
  }
}

function verifyAndDecryptWeChatPayApiV3Notification(
  input: PaymentProviderWebhookInput,
  config: ResolvedConfig,
): VerifiedDecryptedNotification {
  const rawBody = requiredRawBody(input.rawBody);
  const verifiedAt = config.now();
  verifyWeChatPaySignedMessage({
    rawBody,
    headers: input.headers ?? {},
    verificationKeys: config.wechatPayVerificationKeys,
    now: verifiedAt,
    maxSignatureAgeSeconds: config.maxSignatureAgeSeconds,
  });

  const envelope = parseJsonObject(rawBody, "WeChat Pay notification");
  const resource = readEncryptedResource(envelope.resource);
  return {
    eventId: requiredText(envelope.id, "notification.id"),
    eventType: requiredText(
      envelope.event_type,
      "notification.event_type",
    ),
    resourceType: requiredText(
      envelope.resource_type,
      "notification.resource_type",
    ),
    createTime: optionalText(envelope.create_time),
    summary: optionalText(envelope.summary),
    resource,
    decryptedResource: decryptResource(resource, config.apiV3Key),
    verifiedAt,
  };
}

function resolveConfig(config: WeChatPayApiV3Config): ResolvedConfig {
  const appId = requiredConfigText(config.appId, "appId");
  const merchantId = requiredConfigText(config.merchantId, "merchantId");
  const merchantCertificateSerialNumber = requiredConfigText(
    config.merchantCertificateSerialNumber,
    "merchantCertificateSerialNumber",
  );
  const merchantPrivateKey = requiredConfigText(
    config.merchantPrivateKey,
    "merchantPrivateKey",
  );
  const apiV3Key = requiredConfigText(config.apiV3Key, "apiV3Key");
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(appId)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay appId contains unsupported characters.",
    );
  }
  if (!/^\d{6,32}$/.test(merchantId)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchantId must contain 6-32 digits.",
    );
  }
  if (!/^[0-9A-Fa-f]+$/.test(merchantCertificateSerialNumber)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchant certificate serial number must be hexadecimal.",
    );
  }
  if (Buffer.byteLength(apiV3Key, "utf8") !== 32) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay API v3 key must be exactly 32 UTF-8 bytes.",
    );
  }
  let merchantPrivateKeyObject: ReturnType<
    typeof createPrivateKey
  >;
  try {
    merchantPrivateKeyObject =
      createPrivateKey(merchantPrivateKey);
  } catch {
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchant private key is not a valid PEM private key.",
    );
  }
  assertRsa2048Key(
    merchantPrivateKeyObject,
    "WeChat Pay merchant private key",
  );

  const verificationKeys: Record<string, string> = {};
  for (const [serial, pem] of Object.entries(
    config.wechatPayVerificationKeys,
  )) {
    const normalizedSerial = normalizeVerificationKeyId(
      requiredConfigText(serial, "wechatPayVerificationKey id"),
    );
    assertValidVerificationKeyId(
      normalizedSerial,
      "WeChat Pay verification key id",
    );
    const normalizedPem = requiredConfigText(
      pem,
      `wechatPayVerificationKeys.${normalizedSerial}`,
    );
    let verificationKeyObject: ReturnType<
      typeof createPublicKey
    >;
    try {
      verificationKeyObject = createPublicKey(normalizedPem);
    } catch {
      throw new WeChatPayConfigurationError(
        `WeChat Pay verification key ${normalizedSerial} is not a valid PEM public key or certificate.`,
      );
    }
    assertRsa2048Key(
      verificationKeyObject,
      `WeChat Pay verification key ${normalizedSerial}`,
    );
    const existingPem = verificationKeys[normalizedSerial];
    if (existingPem && existingPem !== normalizedPem) {
      throw new WeChatPayConfigurationError(
        `WeChat Pay verification key ${normalizedSerial} has conflicting key material.`,
      );
    }
    verificationKeys[normalizedSerial] = normalizedPem;
  }
  if (Object.keys(verificationKeys).length === 0) {
    throw new WeChatPayConfigurationError(
      "At least one WeChat Pay verification public key is required.",
    );
  }
  const wechatPaySerial = normalizeVerificationKeyId(
    requiredConfigText(config.wechatPaySerial, "wechatPaySerial"),
  );
  assertValidVerificationKeyId(
    wechatPaySerial,
    "WeChat Pay outbound Wechatpay-Serial",
  );
  if (!verificationKeys[wechatPaySerial]) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay outbound Wechatpay-Serial must identify a configured verification key.",
    );
  }

  const notifyUrl = parsePublicHttpsCallbackUrl(
    config.notifyUrl,
    "notifyUrl",
    { requirePath: true },
  );
  const refundNotifyUrl = parsePublicHttpsCallbackUrl(
    config.refundNotifyUrl
      ?? new URL(
        REFUND_NOTIFICATION_PATH,
        new URL(notifyUrl).origin,
      ).toString(),
    "refundNotifyUrl",
    { requirePath: true },
  );
  const apiBaseUrl = parseHttpsUrl(
    config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    "apiBaseUrl",
  );
  const description =
    optionalText(config.description)
    ?? "Delegate 对外代理服务充值";
  if (Array.from(description).length > 127) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay order description must not exceed 127 characters.",
    );
  }
  const maxSignatureAgeSeconds =
    config.maxSignatureAgeSeconds ?? DEFAULT_SIGNATURE_AGE_SECONDS;
  assertPositiveConfigInteger(
    maxSignatureAgeSeconds,
    "maxSignatureAgeSeconds",
  );
  const checkoutLifetimeSeconds =
    config.checkoutLifetimeSeconds
    ?? DEFAULT_CHECKOUT_LIFETIME_SECONDS;
  assertPositiveConfigInteger(
    checkoutLifetimeSeconds,
    "checkoutLifetimeSeconds",
  );
  const requestTimeoutMs =
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs <= 0
    || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new WeChatPayConfigurationError(
      `WeChat Pay requestTimeoutMs must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`,
    );
  }
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new WeChatPayConfigurationError(
      "A fetch implementation is required for WeChat Pay.",
    );
  }

  return {
    resolved: true,
    appId,
    merchantId,
    merchantCertificateSerialNumber,
    merchantPrivateKey,
    apiV3Key,
    wechatPayVerificationKeys: verificationKeys,
    wechatPaySerial,
    notifyUrl,
    refundNotifyUrl,
    description,
    apiBaseUrl,
    fetch: fetchImplementation,
    now: config.now ?? (() => new Date()),
    nonce: config.nonce ?? (() => randomBytes(16).toString("hex")),
    maxSignatureAgeSeconds,
    checkoutLifetimeSeconds,
    requestTimeoutMs,
  };
}

function resolvePublicKeyProbeConfig(
  config: WeChatPayPublicKeyProbeConfig,
): ResolvedRequestConfig {
  const merchantId = requiredConfigText(
    config.merchantId,
    "merchantId",
  );
  if (!/^\d{6,32}$/.test(merchantId)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchantId must contain 6-32 digits.",
    );
  }
  const merchantCertificateSerialNumber = requiredConfigText(
    config.merchantCertificateSerialNumber,
    "merchantCertificateSerialNumber",
  );
  if (!/^[0-9A-Fa-f]+$/.test(merchantCertificateSerialNumber)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchant certificate serial number must be hexadecimal.",
    );
  }
  const merchantPrivateKey = requiredConfigText(
    config.merchantPrivateKey,
    "merchantPrivateKey",
  );
  try {
    const merchantPrivateKeyObject = createPrivateKey(merchantPrivateKey);
    assertRsa2048Key(
      merchantPrivateKeyObject,
      "WeChat Pay merchant private key",
    );
  } catch (error) {
    if (error instanceof WeChatPayConfigurationError) {
      throw error;
    }
    throw new WeChatPayConfigurationError(
      "WeChat Pay merchant private key is not a valid PEM private key.",
    );
  }

  const publicKeyId = requiredConfigText(
    config.publicKeyId,
    "publicKeyId",
  );
  if (!isWeChatPayPublicKeyId(publicKeyId)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay publicKeyId must start with PUB_KEY_ID_ and contain digits after the prefix.",
    );
  }
  const publicKey = requiredConfigText(config.publicKey, "publicKey");
  try {
    const publicKeyObject = createPublicKey(publicKey);
    assertRsa2048Key(
      publicKeyObject,
      `WeChat Pay verification key ${publicKeyId}`,
    );
  } catch (error) {
    if (error instanceof WeChatPayConfigurationError) {
      throw error;
    }
    throw new WeChatPayConfigurationError(
      `WeChat Pay verification key ${publicKeyId} is not a valid PEM public key or certificate.`,
    );
  }

  const maxSignatureAgeSeconds =
    config.maxSignatureAgeSeconds ?? DEFAULT_SIGNATURE_AGE_SECONDS;
  assertPositiveConfigInteger(
    maxSignatureAgeSeconds,
    "maxSignatureAgeSeconds",
  );
  const requestTimeoutMs =
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs <= 0
    || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new WeChatPayConfigurationError(
      `WeChat Pay requestTimeoutMs must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`,
    );
  }
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new WeChatPayConfigurationError(
      "A fetch implementation is required for WeChat Pay.",
    );
  }

  return {
    merchantId,
    merchantCertificateSerialNumber,
    merchantPrivateKey,
    wechatPayVerificationKeys: {
      [publicKeyId]: publicKey,
    },
    wechatPaySerial: publicKeyId,
    apiBaseUrl: parseHttpsUrl(
      config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      "apiBaseUrl",
    ),
    fetch: fetchImplementation,
    now: config.now ?? (() => new Date()),
    nonce: config.nonce ?? (() => randomBytes(16).toString("hex")),
    maxSignatureAgeSeconds,
    requestTimeoutMs,
  };
}

function isResolvedConfig(
  config: WeChatPayApiV3Config | ResolvedConfig,
): config is ResolvedConfig {
  return (config as Partial<ResolvedConfig>).resolved === true;
}

function assertRsa2048Key(
  key: ReturnType<typeof createPrivateKey>
    | ReturnType<typeof createPublicKey>,
  label: string,
): void {
  const keyType = key.asymmetricKeyType;
  const modulusLength =
    key.asymmetricKeyDetails?.modulusLength;
  if (
    keyType !== "rsa"
    || typeof modulusLength !== "number"
    || modulusLength < 2048
  ) {
    throw new WeChatPayConfigurationError(
      `${label} must be an RSA key with a modulus length of at least 2048 bits.`,
    );
  }
}

function signMessage(message: string, privateKey: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(message, "utf8");
  signer.end();
  return signer.sign(privateKey, "base64");
}

async function requestWeChatPayApiV3(input: {
  method: "GET" | "POST";
  canonicalPath: string;
  body?: string;
  config: ResolvedRequestConfig;
}): Promise<{
  response: Response;
  responseBody: Record<string, unknown>;
  verifiedAt: Date;
}> {
  const body = input.body ?? "";
  const timestamp = Math.floor(
    input.config.now().getTime() / 1000,
  ).toString();
  const nonce = input.config.nonce();
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(nonce)) {
    throw new WeChatPayConfigurationError(
      "WeChat Pay request nonce contains unsupported characters.",
    );
  }
  const requestUrl = new URL(
    input.canonicalPath,
    ensureTrailingSlash(input.config.apiBaseUrl),
  );
  const canonicalPath = `${requestUrl.pathname}${requestUrl.search}`;
  if (canonicalPath !== input.canonicalPath) {
    throw new WeChatPayProtocolError(
      "WeChat Pay request canonical URI is invalid.",
    );
  }
  const signature = signMessage(
    `${input.method}\n${canonicalPath}\n${timestamp}\n${nonce}\n${body}\n`,
    input.config.merchantPrivateKey,
  );
  const authorization =
    `${AUTH_SCHEME} `
    + `mchid="${input.config.merchantId}",`
    + `nonce_str="${nonce}",`
    + `timestamp="${timestamp}",`
    + `serial_no="${input.config.merchantCertificateSerialNumber}",`
    + `signature="${signature}"`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "zh-CN",
    Authorization: authorization,
  };
  headers["Wechatpay-Serial"] = input.config.wechatPaySerial;
  if (input.method === "POST") {
    headers["Content-Type"] = "application/json";
  }
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(
        new WeChatPayProtocolError(
          "WeChat Pay API request timed out.",
        ),
      );
    }, input.config.requestTimeoutMs);
  });
  let response: Response;
  let rawResponse: string;
  try {
    response = await Promise.race([
      input.config.fetch(requestUrl, {
        method: input.method,
        headers,
        signal: abortController.signal,
        ...(input.method === "POST" ? { body } : {}),
      }),
      timeout,
    ]);
    rawResponse = await Promise.race([response.text(), timeout]);
  } catch (error) {
    if (error instanceof WeChatPayProtocolError) {
      throw error;
    }
    throw new WeChatPayProtocolError(
      "WeChat Pay API request failed.",
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  const verifiedAt = input.config.now();
  verifyWeChatPaySignedMessage({
    rawBody: rawResponse,
    headers: response.headers,
    verificationKeys: input.config.wechatPayVerificationKeys,
    now: verifiedAt,
    maxSignatureAgeSeconds: input.config.maxSignatureAgeSeconds,
  });
  return {
    response,
    responseBody:
      response.status === 204 && rawResponse.length === 0
        ? {}
        : parseJsonObject(rawResponse, "WeChat Pay API response"),
    verifiedAt,
  };
}

function requiredCanonicalIsoTimestamp(
  value: unknown,
  label: string,
): string {
  const text = requiredText(value, label);
  const parsed = new Date(text);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== text
  ) {
    throw new WeChatPayProtocolError(
      `WeChat Pay ${label} must be a canonical ISO timestamp.`,
    );
  }
  return text;
}

function readWeChatPayRequestId(headers: Headers): string | null {
  return normalizeProviderDiagnosticText(
    headers.get("Request-ID"),
    128,
  );
}

function normalizeProviderDiagnosticText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const normalized = value?.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || !/^[0-9A-Za-z._:-]+$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseWeChatPaySuccessTime(
  value: unknown,
  label: string,
): Date {
  const text = requiredText(value, label);
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) {
    throw new WeChatPayProtocolError(
      `WeChat Pay ${label} must be an RFC 3339 timestamp with second precision.`,
    );
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const localUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
  );
  const localDate = new Date(localUtc);
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
  ) {
    throw new WeChatPayProtocolError(
      `WeChat Pay ${label} is not a valid calendar timestamp.`,
    );
  }
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (
      offsetHours > 14
      || offsetMinute > 59
      || (offsetHours === 14 && offsetMinute !== 0)
    ) {
      throw new WeChatPayProtocolError(
        `WeChat Pay ${label} has an invalid UTC offset.`,
      );
    }
    offsetMinutes =
      (offsetSign === "-" ? -1 : 1)
      * (offsetHours * 60 + offsetMinute);
  }
  return new Date(localUtc - offsetMinutes * 60_000);
}

function assertValidOutTradeNo(outTradeNo: string): void {
  if (
    outTradeNo.length < 6
    || outTradeNo.length > 32
    || !/^[0-9A-Za-z_\-|*]+$/.test(outTradeNo)
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay out_trade_no must be 6-32 characters using letters, numbers, _, -, |, or *.",
    );
  }
}

function assertValidOutRefundNo(outRefundNo: string): void {
  if (
    outRefundNo.length > 64
    || !/^[0-9A-Za-z_\-|*@]+$/.test(outRefundNo)
  ) {
    throw new WeChatPayProtocolError(
      "WeChat Pay out_refund_no must use at most 64 letters, numbers, _, -, |, *, or @ characters.",
    );
  }
}

function isUnpaidTradeState(
  value: string,
): value is Exclude<
  WeChatPayOrderQueryResult["tradeState"],
  "SUCCESS" | null
> {
  return [
    "REFUND",
    "NOTPAY",
    "CLOSED",
    "REVOKED",
    "USERPAYING",
    "PAYERROR",
  ].includes(value);
}

function mapUnpaidTradeState(
  tradeState: Exclude<
    WeChatPayOrderQueryResult["tradeState"],
    "SUCCESS" | null
  >,
): "pending" | "closed" | "refunded" | "failed" {
  if (tradeState === "NOTPAY" || tradeState === "USERPAYING") {
    return "pending";
  }
  if (tradeState === "CLOSED" || tradeState === "REVOKED") {
    return "closed";
  }
  return tradeState === "REFUND" ? "refunded" : "failed";
}

function readEncryptedResource(value: unknown): EncryptedResource {
  const resource = readObject(value, "notification.resource");
  const algorithm = requiredText(
    resource.algorithm,
    "notification.resource.algorithm",
  );
  if (algorithm !== ENCRYPTION_ALGORITHM) {
    throw new WeChatPayProtocolError(
      "WeChat Pay notification encryption algorithm is unsupported.",
    );
  }
  return {
    algorithm,
    ciphertext: requiredText(
      resource.ciphertext,
      "notification.resource.ciphertext",
    ),
    nonce: requiredText(resource.nonce, "notification.resource.nonce"),
    associatedData:
      typeof resource.associated_data === "string"
        ? resource.associated_data
        : "",
    originalType: requiredText(
      resource.original_type,
      "notification.resource.original_type",
    ),
  };
}

function decryptResource(
  resource: EncryptedResource,
  apiV3Key: string,
): Record<string, unknown> {
  const nonce = Buffer.from(resource.nonce, "utf8");
  if (nonce.byteLength !== 12) {
    throw new WeChatPayProtocolError(
      "WeChat Pay encrypted resource nonce must be 12 bytes.",
    );
  }
  if (!isCanonicalBase64(resource.ciphertext)) {
    throw new WeChatPayProtocolError(
      "WeChat Pay encrypted resource ciphertext is invalid.",
    );
  }
  const encrypted = Buffer.from(resource.ciphertext, "base64");
  if (encrypted.byteLength <= 16) {
    throw new WeChatPayProtocolError(
      "WeChat Pay encrypted resource is too short.",
    );
  }
  const authTag = encrypted.subarray(encrypted.byteLength - 16);
  const ciphertext = encrypted.subarray(0, encrypted.byteLength - 16);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(apiV3Key, "utf8"),
      nonce,
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associatedData, "utf8"));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return parseJsonObject(plaintext, "WeChat Pay decrypted transaction");
  } catch (error) {
    if (error instanceof WeChatPayProtocolError) {
      throw error;
    }
    throw new WeChatPayProtocolError(
      "WeChat Pay encrypted resource authentication failed.",
    );
  }
}

function parseVerificationKeyMap(
  serialized: string | undefined,
): Record<string, string> {
  if (!optionalText(serialized)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized!);
  } catch {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_VERIFICATION_KEYS_JSON must be a JSON object.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_VERIFICATION_KEYS_JSON must be a JSON object.",
    );
  }
  const keys: Record<string, string> = {};
  for (const [serial, encodedPem] of Object.entries(parsed)) {
    if (typeof encodedPem !== "string") {
      throw new WeChatPayConfigurationError(
        "Each WeChat Pay verification key must be a PEM or base64 string.",
      );
    }
    const normalizedSerial = normalizeVerificationKeyId(
      requiredConfigText(serial, "verification key id"),
    );
    assertValidVerificationKeyId(
      normalizedSerial,
      "WeChat Pay verification key id",
    );
    const decodedPem = decodePemOrBase64(encodedPem);
    const existingPem = keys[normalizedSerial];
    if (existingPem && existingPem !== decodedPem) {
      throw new WeChatPayConfigurationError(
        `WeChat Pay verification key ${normalizedSerial} has conflicting key material.`,
      );
    }
    keys[normalizedSerial] = decodedPem;
  }
  return keys;
}

function addEnvironmentVerificationKeyPair(
  verificationKeys: Record<string, string>,
  input: {
    keyId: string | undefined;
    keyPem: string | undefined;
    keyIdLabel: string;
    keyPemLabel: string;
  },
): void {
  if (!input.keyId && !input.keyPem) {
    return;
  }
  if (!input.keyId || !input.keyPem) {
    throw new WeChatPayConfigurationError(
      `${input.keyIdLabel} and ${input.keyPemLabel} must be configured together.`,
    );
  }
  const existing = verificationKeys[input.keyId];
  if (existing && existing !== input.keyPem) {
    throw new WeChatPayConfigurationError(
      `WeChat Pay verification key ${input.keyId} conflicts with WECHAT_PAY_VERIFICATION_KEYS_JSON.`,
    );
  }
  verificationKeys[input.keyId] = input.keyPem;
}

function selectOutboundWechatPaySerial(input: {
  verificationKeys: Readonly<Record<string, string>>;
  publicKeyId: string | undefined;
  platformCertificateSerial: string | undefined;
}): string {
  if (input.publicKeyId) {
    return input.publicKeyId;
  }
  if (input.platformCertificateSerial) {
    return input.platformCertificateSerial;
  }

  const configuredKeyIds = Object.keys(input.verificationKeys);
  const publicKeyIds = configuredKeyIds.filter((keyId) =>
    keyId.startsWith("PUB_KEY_ID_")
  );
  if (publicKeyIds.length === 1) {
    return publicKeyIds[0]!;
  }
  if (configuredKeyIds.length === 1) {
    return configuredKeyIds[0]!;
  }
  if (configuredKeyIds.length === 0) {
    throw new WeChatPayConfigurationError(
      "At least one WeChat Pay verification public key is required.",
    );
  }
  throw new WeChatPayConfigurationError(
    "Multiple WeChat Pay verification keys are configured; set WECHAT_PAY_PUBLIC_KEY_ID or WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER to select the outbound Wechatpay-Serial.",
  );
}

function normalizeVerificationKeyId(value: string): string {
  return isPlatformCertificateSerial(value)
    ? value.toUpperCase()
    : value;
}

function isWeChatPayPublicKeyId(value: string): boolean {
  return /^PUB_KEY_ID_\d{1,117}$/.test(value);
}

function isPlatformCertificateSerial(value: string): boolean {
  return /^[0-9A-Fa-f]{1,128}$/.test(value);
}

function assertValidVerificationKeyId(
  value: string,
  label: string,
): void {
  if (
    !isWeChatPayPublicKeyId(value)
    && !isPlatformCertificateSerial(value)
  ) {
    throw new WeChatPayConfigurationError(
      `${label} must be a PUB_KEY_ID_ value or a hexadecimal platform certificate serial number.`,
    );
  }
}

function requiredPemEnvironmentValue(
  plain: string | undefined,
  base64: string | undefined,
  label: string,
): string {
  const value = readPemEnvironmentValue(plain, base64);
  if (!value) {
    throw new WeChatPayConfigurationError(`${label} is required.`);
  }
  return value;
}

function readPemEnvironmentValue(
  plain: string | undefined,
  base64: string | undefined,
): string | undefined {
  if (optionalText(base64)) {
    return decodeBase64Utf8(base64!);
  }
  if (optionalText(plain)) {
    return plain!.replace(/\\n/g, "\n").trim();
  }
  return undefined;
}

function decodePemOrBase64(value: string): string {
  const normalized = value.replace(/\\n/g, "\n").trim();
  return normalized.includes("-----BEGIN ")
    ? normalized
    : decodeBase64Utf8(normalized);
}

function decodeBase64Utf8(value: string): string {
  if (!isCanonicalBase64(value.trim())) {
    throw new WeChatPayConfigurationError(
      "A WeChat Pay PEM environment value is not valid base64.",
    );
  }
  return Buffer.from(value.trim(), "base64").toString("utf8").trim();
}

function requiredEnvironmentText(
  value: string | undefined,
  label: string,
): string {
  const normalized = optionalText(value);
  if (!normalized) {
    throw new WeChatPayConfigurationError(`${label} is required.`);
  }
  return normalized;
}

function requiredRawBody(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WeChatPayProtocolError(
      "WeChat Pay notification raw body is required.",
    );
  }
  return value;
}

function parseJsonObject(
  value: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WeChatPayProtocolError(`${label} is not valid JSON.`);
  }
  return readObject(parsed, label);
}

function readObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeChatPayProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) {
    throw new WeChatPayProtocolError(`${label} is required.`);
  }
  return normalized;
}

function requiredBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  const normalized = requiredText(value, label);
  assertTextByteLength(normalized, label, maxBytes);
  return normalized;
}

function assertTextByteLength(
  value: string,
  label: string,
  maxBytes: number,
): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new WeChatPayProtocolError(
      `${label} must not exceed ${maxBytes} UTF-8 bytes.`,
    );
  }
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function requiredConfigText(value: string, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) {
    throw new WeChatPayConfigurationError(`${label} is required.`);
  }
  return normalized;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WeChatPayProtocolError(
      `${label} must be a positive integer.`,
    );
  }
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw new WeChatPayProtocolError(
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function readNonNegativeSafeInteger(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new WeChatPayProtocolError(
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function assertPositiveConfigInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WeChatPayConfigurationError(
      `${label} must be a positive integer.`,
    );
  }
}

function requiredHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const normalized = optionalHeader(headers, name);
  if (!normalized) {
    throw new WeChatPayProtocolError(
      `WeChat Pay ${name} header is required.`,
    );
  }
  return normalized;
}

function optionalHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value =
    headers instanceof Headers
      ? headers.get(name)
      : Object.entries(headers).find(
          ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
        )?.[1];
  return optionalText(value);
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function resolveWeChatPayNotifyUrlEnvironment(
  env: WeChatPayEnvironment,
): string {
  const explicitNotifyUrl = optionalText(env.WECHAT_PAY_NOTIFY_URL);
  if (explicitNotifyUrl) {
    return parsePublicHttpsCallbackUrl(
      explicitNotifyUrl,
      "WECHAT_PAY_NOTIFY_URL",
      { requirePath: true },
    );
  }

  const representativeUrl = optionalText(
    env.NEXT_PUBLIC_REPRESENTATIVE_URL,
  );
  if (!representativeUrl) {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_NOTIFY_URL or NEXT_PUBLIC_REPRESENTATIVE_URL is required.",
    );
  }
  const normalizedRepresentativeUrl = parsePublicHttpsCallbackUrl(
    representativeUrl,
    "NEXT_PUBLIC_REPRESENTATIVE_URL",
  );
  const parsed = new URL(normalizedRepresentativeUrl);
  if (
    parsed.pathname !== "/"
  ) {
    throw new WeChatPayConfigurationError(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be an origin without a path when deriving the WeChat Pay notify URL.",
    );
  }
  return new URL(PAYMENT_NOTIFICATION_PATH, parsed.origin).toString();
}

function resolveWeChatPayRefundNotifyUrlEnvironment(
  env: WeChatPayEnvironment,
): string {
  const explicitNotifyUrl = optionalText(
    env.WECHAT_PAY_REFUND_NOTIFY_URL,
  );
  if (explicitNotifyUrl) {
    return parsePublicHttpsCallbackUrl(
      explicitNotifyUrl,
      "WECHAT_PAY_REFUND_NOTIFY_URL",
      { requirePath: true },
    );
  }

  const paymentNotifyUrl = optionalText(env.WECHAT_PAY_NOTIFY_URL);
  if (paymentNotifyUrl) {
    const normalizedPaymentNotifyUrl =
      parsePublicHttpsCallbackUrl(
        paymentNotifyUrl,
        "WECHAT_PAY_NOTIFY_URL",
        { requirePath: true },
      );
    return new URL(
      REFUND_NOTIFICATION_PATH,
      new URL(normalizedPaymentNotifyUrl).origin,
    ).toString();
  }

  const representativeUrl = optionalText(
    env.NEXT_PUBLIC_REPRESENTATIVE_URL,
  );
  if (!representativeUrl) {
    throw new WeChatPayConfigurationError(
      "WECHAT_PAY_REFUND_NOTIFY_URL or NEXT_PUBLIC_REPRESENTATIVE_URL is required.",
    );
  }
  const normalizedRepresentativeUrl = parsePublicHttpsCallbackUrl(
    representativeUrl,
    "NEXT_PUBLIC_REPRESENTATIVE_URL",
  );
  const parsed = new URL(normalizedRepresentativeUrl);
  if (parsed.pathname !== "/") {
    throw new WeChatPayConfigurationError(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be an origin without a path when deriving the WeChat Pay refund notify URL.",
    );
  }
  return new URL(REFUND_NOTIFICATION_PATH, parsed.origin).toString();
}

/**
 * Resolves only the public refund callback URL. Dashboard refund intent
 * creation uses this narrow loader so the web process never needs merchant
 * signing keys, the API v3 key, or WeChat verification material.
 */
export function loadWeChatPayRefundNotifyUrlFromEnv(
  env: WeChatPayEnvironment = process.env,
): string {
  return resolveWeChatPayRefundNotifyUrlEnvironment(env);
}

function parsePublicHttpsCallbackUrl(
  value: string,
  label: string,
  options: {
    requirePath?: boolean;
  } = {},
): string {
  const normalized = parseHttpsUrl(value, label);
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const unbracketedHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || isIP(unbracketedHostname) !== 0
    || (options.requirePath && url.pathname === "/")
    || Buffer.byteLength(normalized, "utf8") > 256
  ) {
    throw new WeChatPayConfigurationError(
      `WeChat Pay ${label} must be a public HTTPS URL with a callback path, no credentials/query/fragment, and at most 256 UTF-8 bytes.`,
    );
  }
  return normalized;
}

function parseHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(requiredConfigText(value, label));
  } catch (error) {
    if (error instanceof WeChatPayConfigurationError) {
      throw error;
    }
    throw new WeChatPayConfigurationError(
      `WeChat Pay ${label} must be a valid URL.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new WeChatPayConfigurationError(
      `WeChat Pay ${label} must use HTTPS.`,
    );
  }
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function toRfc3339Seconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
