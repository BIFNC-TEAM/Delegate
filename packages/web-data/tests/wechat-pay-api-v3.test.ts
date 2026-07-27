import {
  createCipheriv,
  generateKeyPairSync,
  sign as signRsa,
  verify as verifyRsa,
} from "node:crypto";

import { PaymentProvider, PaymentProviderEventType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  createWeChatPayApiV3PaymentProviderAdapter,
  createWeChatPayNativeCheckout,
  isWeChatPayApiV3Enabled,
  loadWeChatPayApiV3ConfigFromEnv,
  queryWeChatPayOrderByOutTradeNo,
  verifyWeChatPayApiV3Notification,
  verifyWeChatPayApiV3RefundNotification,
  verifyWeChatPaySignedMessage,
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  type WeChatPayApiV3Config,
} from "../src/wechat-pay-api-v3";

const FIXED_NOW = new Date("2026-07-27T08:00:00.000Z");
const FIXED_TIMESTAMP = Math.floor(FIXED_NOW.getTime() / 1000).toString();
const PLATFORM_KEY_ID = "PUB_KEY_ID_01111111111111111111111111111111";
const LEGACY_PLATFORM_CERTIFICATE_SERIAL = "5E6F7A8B9C0D";
const MERCHANT_CERTIFICATE_SERIAL = "7A2A3B4C5D6E";
const API_V3_KEY = "0123456789abcdef0123456789abcdef";

const merchantKeyPair = generateRsaKeyPair();
const platformKeyPair = generateRsaKeyPair();
const legacyPlatformKeyPair = generateRsaKeyPair();

describe("WeChat Pay API v3", () => {
  it("signs the exact Native request and accepts only a signed response", async () => {
    const rawResponse = JSON.stringify({
      code_url: "weixin://wxpay/bizpayurl?pr=test-native-order",
    });
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const config = createConfig({
      fetch: async (url, init) => {
        capturedUrl = url instanceof URL ? url : new URL(url.toString());
        capturedInit = init;
        return signedResponse(rawResponse);
      },
    });

    const checkout = await createWeChatPayNativeCheckout(
      {
        rechargeOrderId: "recharge_123",
        externalUserId: "web:user_1",
        amountCents: 2_500,
        currency: "CNY",
        idempotencyKey: "wechat_recharge_123",
      },
      config,
    );

    const expectedBody = JSON.stringify({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      description: "Delegate 数字代表服务充值",
      out_trade_no: "recharge_123",
      time_expire: "2026-07-27T10:00:00Z",
      notify_url: "https://delegate.example/api/payments/wechat/notify",
      amount: {
        total: 2_500,
        currency: "CNY",
      },
    });
    expect(capturedUrl?.toString()).toBe(
      "https://wechat-pay.example/v3/pay/transactions/native",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe(expectedBody);
    expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(
      new Headers(capturedInit?.headers).get("Wechatpay-Serial"),
    ).toBe(PLATFORM_KEY_ID);

    const authorization = requiredHeader(
      new Headers(capturedInit?.headers),
      "Authorization",
    );
    expect(authorization).toContain(
      'WECHATPAY2-SHA256-RSA2048 mchid="1900000109"',
    );
    expect(authorization).toContain(
      `serial_no="${MERCHANT_CERTIFICATE_SERIAL}"`,
    );
    expect(authorization).toContain('nonce_str="merchant-request-nonce"');
    const requestSignature = requiredAuthorizationField(
      authorization,
      "signature",
    );
    const requestMessage =
      `POST\n/v3/pay/transactions/native\n${FIXED_TIMESTAMP}\n`
      + `merchant-request-nonce\n${expectedBody}\n`;
    expect(
      verifyRsa(
        "RSA-SHA256",
        Buffer.from(requestMessage, "utf8"),
        merchantKeyPair.publicKey,
        Buffer.from(requestSignature, "base64"),
      ),
    ).toBe(true);

    expect(checkout).toEqual({
      providerOrderId: "recharge_123",
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=test-native-order",
      rawPayload: {
        mode: "native",
        outTradeNo: "recharge_123",
        expiresAt: "2026-07-27T10:00:00.000Z",
      },
    });
  });

  it("rejects a Native response whose body no longer matches its RSA signature", async () => {
    const signedBody = JSON.stringify({
      code_url: "weixin://wxpay/bizpayurl?pr=authentic",
    });
    const tamperedBody = JSON.stringify({
      code_url: "weixin://wxpay/bizpayurl?pr=tampered",
    });
    const config = createConfig({
      fetch: async () =>
        new Response(tamperedBody, {
          status: 200,
          headers: signedHeaders(signedBody),
        }),
    });

    await expect(
      createWeChatPayNativeCheckout(
        {
          rechargeOrderId: "recharge_456",
          externalUserId: "web:user_1",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_recharge_456",
        },
        config,
      ),
    ).rejects.toThrow("signature verification failed");
  });

  it("requests a public-key response while accepting a legacy certificate-signed response during migration", async () => {
    const rawResponse = JSON.stringify({
      code_url: "weixin://wxpay/bizpayurl?pr=gray-migration",
    });
    let capturedHeaders: Headers | undefined;
    const config = createConfig({
      wechatPayVerificationKeys: {
        [PLATFORM_KEY_ID]: platformKeyPair.publicKey,
        [LEGACY_PLATFORM_CERTIFICATE_SERIAL]:
          legacyPlatformKeyPair.publicKey,
      },
      fetch: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(rawResponse, {
          status: 200,
          headers: signedHeaders(rawResponse, {
            serial: LEGACY_PLATFORM_CERTIFICATE_SERIAL,
            privateKey: legacyPlatformKeyPair.privateKey,
          }),
        });
      },
    });

    await expect(
      createWeChatPayNativeCheckout(
        {
          rechargeOrderId: "recharge_gray_001",
          externalUserId: "web:user_1",
          amountCents: 1_200,
          currency: "CNY",
          idempotencyKey: "wechat_recharge_gray_001",
        },
        config,
      ),
    ).resolves.toMatchObject({
      checkoutUrl: "weixin://wxpay/bizpayurl?pr=gray-migration",
    });
    expect(capturedHeaders?.get("Wechatpay-Serial")).toBe(
      PLATFORM_KEY_ID,
    );
  });

  it("queries by merchant order number with the exact canonical URI and returns a minimal paid event", async () => {
    const rawResponse = JSON.stringify({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_query_paid",
      transaction_id: "4200000000202607270000000099",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      success_time: "2026-07-27T16:00:01+08:00",
      amount: {
        total: 2_500,
        currency: "CNY",
      },
      payer: {
        openid: "o-query-sensitive-open-id",
      },
      bank_type: "query-sensitive-bank-type",
    });
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const config = createConfig({
      fetch: async (url, init) => {
        capturedUrl = url instanceof URL ? url : new URL(url.toString());
        capturedInit = init;
        return signedResponse(rawResponse);
      },
    });

    const result = await queryWeChatPayOrderByOutTradeNo(
      "recharge_query_paid",
      config,
    );

    const canonicalUri =
      "/v3/pay/transactions/out-trade-no/recharge_query_paid"
      + "?mchid=1900000109";
    expect(capturedUrl?.toString()).toBe(
      `https://wechat-pay.example${canonicalUri}`,
    );
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.body).toBeUndefined();
    expect(
      new Headers(capturedInit?.headers).get("Wechatpay-Serial"),
    ).toBe(PLATFORM_KEY_ID);
    const authorization = requiredHeader(
      new Headers(capturedInit?.headers),
      "Authorization",
    );
    const requestSignature = requiredAuthorizationField(
      authorization,
      "signature",
    );
    const requestMessage =
      `GET\n${canonicalUri}\n${FIXED_TIMESTAMP}\n`
      + "merchant-request-nonce\n\n";
    expect(
      verifyRsa(
        "RSA-SHA256",
        Buffer.from(requestMessage, "utf8"),
        merchantKeyPair.publicKey,
        Buffer.from(requestSignature, "base64"),
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      status: "paid",
      tradeState: "SUCCESS",
      event: {
        provider: PaymentProvider.WECHAT_PAY,
        providerEventId:
          "query:4200000000202607270000000099",
        providerTransactionId:
          "4200000000202607270000000099",
        eventType: PaymentProviderEventType.RECHARGE_PAID,
        rechargeOrderId: "recharge_query_paid",
        providerOrderId: "recharge_query_paid",
        amountCents: 2_500,
        currency: "CNY",
        idempotencyKey:
          "wechat_pay:query:4200000000202607270000000099",
        verifiedAt: FIXED_NOW,
        providerOccurredAt: new Date(
          "2026-07-27T08:00:01.000Z",
        ),
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      "o-query-sensitive-open-id",
    );
    expect(JSON.stringify(result)).not.toContain(
      "query-sensitive-bank-type",
    );
    expect(JSON.stringify(result)).not.toContain('"payer"');
    expect(JSON.stringify(result)).not.toContain('"bank_type"');
  });

  it.each([
    ["NOTPAY", "pending"],
    ["USERPAYING", "pending"],
    ["CLOSED", "closed"],
    ["REFUND", "refunded"],
    ["PAYERROR", "failed"],
  ] as const)(
    "maps a signed %s order query response to %s without producing a paid event",
    async (tradeState, expectedStatus) => {
      const rawResponse = JSON.stringify({
        appid: "wx-test-app-id",
        mchid: "1900000109",
        out_trade_no: "recharge_query_pending",
        trade_type: "NATIVE",
        trade_state: tradeState,
        amount: {
          total: 1_200,
          currency: "CNY",
        },
      });
      const result = await queryWeChatPayOrderByOutTradeNo(
        "recharge_query_pending",
        createConfig({
          fetch: async () => signedResponse(rawResponse),
        }),
      );

      expect(result).toEqual({
        status: expectedStatus,
        tradeState,
        event: null,
      });
    },
  );

  it("rejects a queried order response whose body was changed after signing", async () => {
    const signedBody = JSON.stringify({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_query_tamper",
      trade_type: "NATIVE",
      trade_state: "NOTPAY",
      amount: {
        total: 800,
        currency: "CNY",
      },
    });
    const tamperedBody = signedBody.replace(
      '"total":800',
      '"total":80000',
    );

    await expect(
      queryWeChatPayOrderByOutTradeNo(
        "recharge_query_tamper",
        createConfig({
          fetch: async () =>
            new Response(tamperedBody, {
              status: 200,
              headers: signedHeaders(signedBody),
            }),
        }),
      ),
    ).rejects.toThrow("signature verification failed");
  });

  it("rejects a signed queried order response for a different merchant order", async () => {
    const rawResponse = JSON.stringify({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_query_other",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      transaction_id: "4200000000202607270000000100",
      amount: {
        total: 800,
        currency: "CNY",
      },
    });

    await expect(
      queryWeChatPayOrderByOutTradeNo(
        "recharge_query_expected",
        createConfig({
          fetch: async () => signedResponse(rawResponse),
        }),
      ),
    ).rejects.toThrow("identity does not match");
  });

  it.each([
    ["missing", undefined],
    ["invalid format", "2026-07-27 16:00:01"],
    ["invalid calendar date", "2026-02-30T16:00:01+08:00"],
    ["invalid UTC offset", "2026-07-27T16:00:01+14:01"],
  ])(
    "rejects a paid query with %s success_time",
    async (_caseName, successTime) => {
      const rawResponse = JSON.stringify({
        appid: "wx-test-app-id",
        mchid: "1900000109",
        out_trade_no: "recharge_query_bad_time",
        transaction_id: "4200000000202607270000000101",
        trade_type: "NATIVE",
        trade_state: "SUCCESS",
        ...(successTime ? { success_time: successTime } : {}),
        amount: {
          total: 800,
          currency: "CNY",
        },
      });

      await expect(
        queryWeChatPayOrderByOutTradeNo(
          "recharge_query_bad_time",
          createConfig({
            fetch: async () => signedResponse(rawResponse),
          }),
        ),
      ).rejects.toThrow(WeChatPayProtocolError);
    },
  );

  it("verifies and decrypts an AES-256-GCM payment notification", async () => {
    const { rawBody, headers } = createSignedNotification({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_789",
      transaction_id: "4200000000202607270000000001",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      success_time: "2026-07-27T16:00:01+08:00",
      amount: {
        total: 3_600,
        currency: "CNY",
      },
      payer: {
        openid: "o-sensitive-open-id",
      },
      bank_type: "sensitive-bank-type",
    });

    const verification = await verifyWeChatPayApiV3Notification(
      { rawBody, headers },
      createConfig(),
    );

    expect(verification).toMatchObject({
      verified: true,
      payload: {
        providerEventId: "EV-20260727-0001",
        transactionId: "4200000000202607270000000001",
        rechargeOrderId: "recharge_789",
        providerOrderId: "recharge_789",
        amountCents: 3_600,
        currency: "CNY",
        status: "SUCCESS",
        eventType: "TRANSACTION.SUCCESS",
        appId: "wx-test-app-id",
        merchantId: "1900000109",
        tradeType: "NATIVE",
        successTime: "2026-07-27T08:00:01.000Z",
      },
      rawPayload: {
        id: "EV-20260727-0001",
        eventType: "TRANSACTION.SUCCESS",
        resourceType: "encrypt-resource",
        resource: {
          algorithm: "AEAD_AES_256_GCM",
          originalType: "transaction",
        },
      },
    });
  });

  it("keeps decrypted payer details out of normalized and persisted raw payloads", async () => {
    const sensitiveOpenId = "o-sensitive-open-id-never-persist";
    const sensitiveBankType = "sensitive-bank-type-never-persist";
    const { rawBody, headers } = createSignedNotification({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_sensitive",
      transaction_id: "4200000000202607270000000002",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      success_time: "2026-07-27T16:00:01+08:00",
      amount: {
        total: 888,
        currency: "CNY",
      },
      payer: {
        openid: sensitiveOpenId,
      },
      bank_type: sensitiveBankType,
    });
    const adapter = createWeChatPayApiV3PaymentProviderAdapter(createConfig());

    const event = await adapter.normalizeWebhookEvent({ rawBody, headers });

    expect(event).toMatchObject({
      provider: PaymentProvider.WECHAT_PAY,
      providerEventId: "EV-20260727-0001",
      eventType: PaymentProviderEventType.RECHARGE_PAID,
      rechargeOrderId: "recharge_sensitive",
      providerOrderId: "recharge_sensitive",
      amountCents: 888,
      currency: "CNY",
      idempotencyKey: "wechat_pay:EV-20260727-0001",
      providerOccurredAt: new Date(
        "2026-07-27T08:00:01.000Z",
      ),
      normalizedPayload: {
        type: "RechargePaid",
        provider: "wechat_pay",
      },
    });
    const persistedPayloads = JSON.stringify({
      rawPayload: event.rawPayload,
      normalizedPayload: event.normalizedPayload,
    });
    expect(persistedPayloads).not.toContain(sensitiveOpenId);
    expect(persistedPayloads).not.toContain(sensitiveBankType);
    expect(persistedPayloads).not.toContain('"payer"');
    expect(persistedPayloads).not.toContain('"bank_type"');
  });

  it("verifies a successful refund notification and returns only safe persistence payloads", async () => {
    const sensitiveReceivedAccount =
      "sensitive-user-bank-account-never-persist";
    const notification = createSignedRefundNotification(
      validRefundResource({
        user_received_account: sensitiveReceivedAccount,
      }),
    );

    const result = await verifyWeChatPayApiV3RefundNotification(
      notification,
      createConfig(),
    );

    expect(result).toMatchObject({
      provider: PaymentProvider.WECHAT_PAY,
      providerEventId: "EV-REFUND-20260727-0001",
      refundId: "5000000000202607270000000001",
      outRefundNo: "refund_recharge_refund_001",
      outTradeNo: "recharge_refund_001",
      transactionId: "4200000000202607270000000099",
      merchantId: "1900000109",
      refundStatus: "SUCCESS",
      originalAmountCents: 3_600,
      refundAmountCents: 1_200,
      payerAmountCents: 3_200,
      payerRefundAmountCents: 1_000,
      idempotencyKey:
        "wechat_pay:refund_notification:EV-REFUND-20260727-0001",
      verifiedAt: FIXED_NOW,
      providerOccurredAt: new Date(
        "2026-07-27T08:00:02.000Z",
      ),
      rawPayload: {
        id: "EV-REFUND-20260727-0001",
        createTime: "2026-07-27T16:00:01+08:00",
        resourceType: "encrypt-resource",
        eventType: "REFUND.SUCCESS",
        summary: "退款成功",
        resource: {
          algorithm: "AEAD_AES_256_GCM",
          originalType: "refund",
          associatedData: "refund",
        },
      },
      normalizedPayload: {
        type: "RechargeRefunded",
        provider: "wechat_pay",
        providerEventId: "EV-REFUND-20260727-0001",
        providerRefundId: "5000000000202607270000000001",
        providerRefundOrderId: "refund_recharge_refund_001",
        providerPaymentTransactionId:
          "4200000000202607270000000099",
        rechargeOrderId: "recharge_refund_001",
        merchantId: "1900000109",
        refundStatus: "SUCCESS",
        originalAmountCents: 3_600,
        refundAmountCents: 1_200,
        payerAmountCents: 3_200,
        payerRefundAmountCents: 1_000,
        providerOccurredAt: "2026-07-27T08:00:02.000Z",
      },
    });
    const persistencePayloads = JSON.stringify({
      rawPayload: result.rawPayload,
      normalizedPayload: result.normalizedPayload,
    });
    expect(persistencePayloads).not.toContain(sensitiveReceivedAccount);
    expect(persistencePayloads).not.toContain(
      "user_received_account",
    );
  });

  it("accepts zero payer amounts so discounted refunds can be quarantined after verification", async () => {
    const result = await verifyWeChatPayApiV3RefundNotification(
      createSignedRefundNotification(
        validRefundResource({
          amount: {
            total: 3_600,
            refund: 1_200,
            payer_total: 0,
            payer_refund: 0,
          },
        }),
      ),
      createConfig(),
    );

    expect(result).toMatchObject({
      originalAmountCents: 3_600,
      refundAmountCents: 1_200,
      payerAmountCents: 0,
      payerRefundAmountCents: 0,
    });
  });

  it.each([
    [
      "CLOSED",
      "REFUND.CLOSED",
      "RechargeRefundClosed",
    ],
    [
      "ABNORMAL",
      "REFUND.ABNORMAL",
      "RechargeRefundAbnormal",
    ],
  ] as const)(
    "verifies a %s refund status notification without requiring success_time",
    async (refundStatus, eventType, normalizedType) => {
      const result = await verifyWeChatPayApiV3RefundNotification(
        createSignedRefundNotification(
          validRefundResource({
            refund_status: refundStatus,
            success_time: undefined,
          }),
          { eventType },
        ),
        createConfig(),
      );

      expect(result).toMatchObject({
        refundStatus,
        providerOccurredAt: new Date(
          "2026-07-27T08:00:01.000Z",
        ),
        rawPayload: { eventType },
        normalizedPayload: {
          type: normalizedType,
          refundStatus,
          providerOccurredAt: "2026-07-27T08:00:01.000Z",
        },
      });
    },
  );

  it("rejects a refund notification with an invalid outer signature", async () => {
    const notification = createSignedRefundNotification(
      validRefundResource(),
    );

    await expect(
      verifyWeChatPayApiV3RefundNotification(
        {
          ...notification,
          headers: signedHeaders('{"different":"body"}'),
        },
        createConfig(),
      ),
    ).rejects.toThrow("signature verification failed");
  });

  it("rejects a refund notification for a different merchant", async () => {
    const notification = createSignedRefundNotification(
      validRefundResource({
        mchid: "1900000199",
      }),
    );

    await expect(
      verifyWeChatPayApiV3RefundNotification(
        notification,
        createConfig(),
      ),
    ).rejects.toThrow(
      "refund notification merchant identity does not match",
    );
  });

  it("rejects a refund notification with a non-refund encrypted resource", async () => {
    const notification = createSignedRefundNotification(
      validRefundResource(),
      {
        originalType: "transaction",
      },
    );

    await expect(
      verifyWeChatPayApiV3RefundNotification(
        notification,
        createConfig(),
      ),
    ).rejects.toThrow("resource type is not a refund");
  });

  it.each([
    {
      caseName: "an envelope/resource status mismatch",
      resource: validRefundResource(),
      notificationOverrides: {
        eventType: "REFUND.ABNORMAL",
      },
    },
    {
      caseName: "a non-success refund status",
      resource: validRefundResource({
        refund_status: "PROCESSING",
      }),
      notificationOverrides: {},
    },
  ])(
    "rejects a refund notification with $caseName",
    async ({ resource, notificationOverrides }) => {
      await expect(
        verifyWeChatPayApiV3RefundNotification(
          createSignedRefundNotification(
            resource,
            notificationOverrides,
          ),
          createConfig(),
        ),
      ).rejects.toThrow(WeChatPayProtocolError);
    },
  );

  it.each([
    {
      caseName: "a zero refund amount",
      resource: validRefundResource({
        amount: {
          total: 3_600,
          refund: 0,
          payer_total: 3_200,
          payer_refund: 1_000,
        },
      }),
    },
    {
      caseName: "a refund larger than the order",
      resource: validRefundResource({
        amount: {
          total: 3_600,
          refund: 3_601,
          payer_total: 3_200,
          payer_refund: 1_000,
        },
      }),
    },
    {
      caseName: "an inconsistent payer refund",
      resource: validRefundResource({
        amount: {
          total: 3_600,
          refund: 1_200,
          payer_total: 3_200,
          payer_refund: 1_201,
        },
      }),
    },
    {
      caseName: "a non-integer amount",
      resource: validRefundResource({
        amount: {
          total: 3_600,
          refund: "1200",
          payer_total: 3_200,
          payer_refund: 1_000,
        },
      }),
    },
    {
      caseName: "an invalid success time",
      resource: validRefundResource({
        success_time: "2026-02-30T16:00:02+08:00",
      }),
    },
    {
      caseName: "an overlong refund order number",
      resource: validRefundResource({
        out_refund_no: "r".repeat(65),
      }),
    },
  ])(
    "rejects a refund notification with $caseName",
    async ({ resource }) => {
      await expect(
        verifyWeChatPayApiV3RefundNotification(
          createSignedRefundNotification(resource),
          createConfig(),
        ),
      ).rejects.toThrow(WeChatPayProtocolError);
    },
  );

  it.each([
    {
      caseName: "tampered body",
      rawBody: '{"id":"tampered"}',
      now: FIXED_NOW,
      verificationKeys: {
        [PLATFORM_KEY_ID]: platformKeyPair.publicKey,
      },
      expectedMessage: "signature verification failed",
    },
    {
      caseName: "expired timestamp",
      rawBody: '{"id":"authentic"}',
      now: new Date(FIXED_NOW.getTime() + 301_000),
      verificationKeys: {
        [PLATFORM_KEY_ID]: platformKeyPair.publicKey,
      },
      expectedMessage: "outside the accepted window",
    },
    {
      caseName: "unknown verification key",
      rawBody: '{"id":"authentic"}',
      now: FIXED_NOW,
      verificationKeys: {},
      expectedMessage: "key id is not configured",
    },
  ])(
    "rejects a signed message with $caseName",
    ({ rawBody, now, verificationKeys, expectedMessage }) => {
      const authenticBody = '{"id":"authentic"}';

      expect(() =>
        verifyWeChatPaySignedMessage({
          rawBody,
          headers: signedHeaders(authenticBody),
          verificationKeys,
          now,
        }),
      ).toThrow(expectedMessage);
    },
  );

  it("fails notification verification closed after ciphertext tampering", async () => {
    const notification = createSignedNotification({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_tamper",
      transaction_id: "4200000000202607270000000003",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      amount: {
        total: 600,
        currency: "CNY",
      },
    });
    const envelope = JSON.parse(notification.rawBody) as {
      resource: { ciphertext: string };
    };
    envelope.resource.ciphertext =
      `${envelope.resource.ciphertext.slice(0, -4)}AAAA`;
    const tamperedRawBody = JSON.stringify(envelope);

    const verification = await verifyWeChatPayApiV3Notification(
      {
        rawBody: tamperedRawBody,
        // Sign the changed envelope so this specifically reaches GCM
        // authentication rather than failing at the outer RSA signature.
        headers: signedHeaders(tamperedRawBody),
      },
      createConfig(),
    );

    expect(verification).toEqual({
      verified: false,
      reason: "WeChat Pay notification verification failed.",
    });
  });

  it("fails notification verification closed for an invalid success_time", async () => {
    const notification = createSignedNotification({
      appid: "wx-test-app-id",
      mchid: "1900000109",
      out_trade_no: "recharge_bad_time",
      transaction_id: "4200000000202607270000000004",
      trade_type: "NATIVE",
      trade_state: "SUCCESS",
      success_time: "2026-02-30T16:00:01+08:00",
      amount: {
        total: 600,
        currency: "CNY",
      },
    });

    await expect(
      verifyWeChatPayApiV3Notification(
        notification,
        createConfig(),
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "WeChat Pay notification verification failed.",
    });
  });

  it("bounds API calls and hides network implementation errors", async () => {
    const checkoutInput = {
      rechargeOrderId: "recharge_timeout",
      externalUserId: "web:user_1",
      amountCents: 900,
      currency: "CNY",
      idempotencyKey: "wechat_recharge_timeout",
    };
    const timedOut = createWeChatPayNativeCheckout(
      checkoutInput,
      createConfig({
        requestTimeoutMs: 5,
        fetch: async () => new Promise<Response>(() => {}),
      }),
    );
    await expect(timedOut).rejects.toMatchObject({
      name: "WeChatPayProtocolError",
      message: "WeChat Pay API request timed out.",
    });

    const secretNetworkDetail = "secret internal DNS detail";
    let networkError: unknown;
    try {
      await createWeChatPayNativeCheckout(
        checkoutInput,
        createConfig({
          fetch: async () => {
            throw new Error(secretNetworkDetail);
          },
        }),
      );
    } catch (error) {
      networkError = error;
    }
    expect(networkError).toBeInstanceOf(WeChatPayProtocolError);
    expect(String(networkError)).toContain(
      "WeChat Pay API request failed.",
    );
    expect(String(networkError)).not.toContain(secretNetworkDetail);

    const secretReadDetail = "secret socket read detail";
    let readError: unknown;
    try {
      await createWeChatPayNativeCheckout(
        checkoutInput,
        createConfig({
          fetch: async () =>
            ({
              text: async () => {
                throw new Error(secretReadDetail);
              },
            }) as unknown as Response,
        }),
      );
    } catch (error) {
      readError = error;
    }
    expect(readError).toBeInstanceOf(WeChatPayProtocolError);
    expect(String(readError)).toContain(
      "WeChat Pay API request failed.",
    );
    expect(String(readError)).not.toContain(secretReadDetail);
  });

  it("loads environment credentials only behind an exact opt-in and fails closed", () => {
    expect(isWeChatPayApiV3Enabled({})).toBe(false);
    expect(
      isWeChatPayApiV3Enabled({ DELEGATE_WECHAT_PAY_ENABLED: "TRUE" }),
    ).toBe(false);
    expect(() => loadWeChatPayApiV3ConfigFromEnv({})).toThrow(
      WeChatPayConfigurationError,
    );
    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
      }),
    ).toThrow("WECHAT_PAY_APP_ID is required");

    expect(() =>
      createWeChatPayApiV3PaymentProviderAdapter({
        ...createConfig(),
        apiV3Key: "too-short",
      }),
    ).toThrow("API v3 key must be exactly 32 UTF-8 bytes");
    expect(() =>
      createWeChatPayApiV3PaymentProviderAdapter({
        ...createConfig(),
        wechatPayVerificationKeys: {},
      }),
    ).toThrow("At least one WeChat Pay verification public key is required");
    expect(() =>
      createWeChatPayApiV3PaymentProviderAdapter({
        ...createConfig(),
        wechatPaySerial: "DEADBEEF",
      }),
    ).toThrow(
      "outbound Wechatpay-Serial must identify a configured verification key",
    );
    for (const requestTimeoutMs of [0, 1.5, 60_001]) {
      expect(() =>
        createWeChatPayApiV3PaymentProviderAdapter({
          ...createConfig(),
          requestTimeoutMs,
        }),
      ).toThrow(
        "requestTimeoutMs must be an integer between 1 and 60000",
      );
    }
  });

  it("derives the payment notify URL and keeps public-key plus legacy certificate verification during migration", () => {
    const config = loadWeChatPayApiV3ConfigFromEnv(
      validEnvironment({
        WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER:
          LEGACY_PLATFORM_CERTIFICATE_SERIAL.toLowerCase(),
        WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64:
          encodePem(legacyPlatformKeyPair.publicKey),
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://reps.delegate.example/",
      }),
    );

    expect(config.notifyUrl).toBe(
      "https://reps.delegate.example/api/payments/wechat/notify",
    );
    expect(config.wechatPaySerial).toBe(PLATFORM_KEY_ID);
    expect(Object.keys(config.wechatPayVerificationKeys).sort()).toEqual(
      [
        LEGACY_PLATFORM_CERTIFICATE_SERIAL,
        PLATFORM_KEY_ID,
      ].sort(),
    );

    const rawBody = JSON.stringify({ id: "dual-verification" });
    for (const [serial, privateKey] of [
      [PLATFORM_KEY_ID, platformKeyPair.privateKey],
      [
        LEGACY_PLATFORM_CERTIFICATE_SERIAL,
        legacyPlatformKeyPair.privateKey,
      ],
    ] as const) {
      expect(() =>
        verifyWeChatPaySignedMessage({
          rawBody,
          headers: signedHeaders(rawBody, {
            serial,
            privateKey,
          }),
          verificationKeys: config.wechatPayVerificationKeys,
          now: FIXED_NOW,
        }),
      ).not.toThrow();
    }
  });

  it("allows an explicit public notify URL to override the representative development URL", () => {
    const config = loadWeChatPayApiV3ConfigFromEnv(
      validEnvironment({
        NEXT_PUBLIC_REPRESENTATIVE_URL: "http://localhost:3002",
        WECHAT_PAY_NOTIFY_URL:
          "https://callbacks.delegate.example/wechat/payment",
      }),
    );

    expect(config.notifyUrl).toBe(
      "https://callbacks.delegate.example/wechat/payment",
    );
  });

  it("fails closed for incomplete or conflicting verification-key migration settings", () => {
    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_PUBLIC_KEY_ID: "PUBLIC_KEY_WITHOUT_PREFIX",
        }),
      ),
    ).toThrow("WECHAT_PAY_PUBLIC_KEY_ID must start with PUB_KEY_ID_");

    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER:
            "not-a-certificate-serial",
          WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64:
            encodePem(legacyPlatformKeyPair.publicKey),
        }),
      ),
    ).toThrow(
      "WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER must be hexadecimal",
    );

    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_PUBLIC_KEY_BASE64: "",
        }),
      ),
    ).toThrow(
      "WECHAT_PAY_PUBLIC_KEY_ID and WECHAT_PAY_PUBLIC_KEY/WECHAT_PAY_PUBLIC_KEY_BASE64 must be configured together",
    );

    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER:
            LEGACY_PLATFORM_CERTIFICATE_SERIAL,
        }),
      ),
    ).toThrow(
      "WECHAT_PAY_PLATFORM_CERTIFICATE_SERIAL_NUMBER and WECHAT_PAY_PLATFORM_CERTIFICATE/WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64 must be configured together",
    );

    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_VERIFICATION_KEYS_JSON: JSON.stringify({
            [PLATFORM_KEY_ID]: encodePem(
              legacyPlatformKeyPair.publicKey,
            ),
          }),
        }),
      ),
    ).toThrow("conflicts with WECHAT_PAY_VERIFICATION_KEYS_JSON");

    expect(() =>
      loadWeChatPayApiV3ConfigFromEnv(
        validEnvironment({
          WECHAT_PAY_PUBLIC_KEY_ID: "",
          WECHAT_PAY_PUBLIC_KEY_BASE64: "",
          WECHAT_PAY_VERIFICATION_KEYS_JSON: JSON.stringify({
            A1B2C3: encodePem(platformKeyPair.publicKey),
            D4E5F6:
              encodePem(legacyPlatformKeyPair.publicKey),
          }),
        }),
      ),
    ).toThrow("Multiple WeChat Pay verification keys are configured");
  });

  it("fails closed when the callback URL cannot be a public WeChat endpoint", () => {
    for (const invalidEnvironment of [
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "",
      },
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "http://reps.delegate.example",
      },
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://localhost:3002",
      },
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL: "https://localhost.",
      },
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://user:password@reps.delegate.example",
      },
      {
        NEXT_PUBLIC_REPRESENTATIVE_URL:
          "https://reps.delegate.example/base",
      },
      {
        WECHAT_PAY_NOTIFY_URL:
          "https://127.0.0.1/api/payments/wechat/notify",
      },
      {
        WECHAT_PAY_NOTIFY_URL:
          "https://callbacks.delegate.example/api/payments/wechat/notify?source=wechat",
      },
      {
        WECHAT_PAY_NOTIFY_URL:
          "https://callbacks.delegate.example/api/payments/wechat/notify#fragment",
      },
      {
        WECHAT_PAY_NOTIFY_URL:
          "https://callbacks.delegate.example",
      },
      {
        WECHAT_PAY_NOTIFY_URL:
          `https://callbacks.delegate.example/${"a".repeat(256)}`,
      },
    ]) {
      expect(() =>
        loadWeChatPayApiV3ConfigFromEnv(
          validEnvironment(invalidEnvironment),
        ),
      ).toThrow(WeChatPayConfigurationError);
    }
  });

  it("does not accept a response signed by an unknown platform key", async () => {
    const rawResponse = JSON.stringify({
      code_url: "weixin://wxpay/bizpayurl?pr=unknown-key",
    });
    const config = createConfig({
      fetch: async () =>
        new Response(rawResponse, {
          status: 200,
          headers: signedHeaders(rawResponse, {
            serial: "UNKNOWN_PLATFORM_KEY",
          }),
        }),
    });

    await expect(
      createWeChatPayNativeCheckout(
        {
          rechargeOrderId: "recharge_unknown",
          externalUserId: "web:user_1",
          amountCents: 900,
          currency: "CNY",
          idempotencyKey: "wechat_recharge_unknown",
        },
        config,
      ),
    ).rejects.toThrow(WeChatPayProtocolError);
  });
});

function createConfig(
  overrides: Partial<WeChatPayApiV3Config> = {},
): WeChatPayApiV3Config {
  return {
    appId: "wx-test-app-id",
    merchantId: "1900000109",
    merchantCertificateSerialNumber: MERCHANT_CERTIFICATE_SERIAL,
    merchantPrivateKey: merchantKeyPair.privateKey,
    apiV3Key: API_V3_KEY,
    wechatPayVerificationKeys: {
      [PLATFORM_KEY_ID]: platformKeyPair.publicKey,
    },
    wechatPaySerial: PLATFORM_KEY_ID,
    notifyUrl: "https://delegate.example/api/payments/wechat/notify",
    apiBaseUrl: "https://wechat-pay.example",
    fetch: async () => {
      throw new Error("Unexpected network request.");
    },
    now: () => FIXED_NOW,
    nonce: () => "merchant-request-nonce",
    ...overrides,
  };
}

function validEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    DELEGATE_WECHAT_PAY_ENABLED: "true",
    WECHAT_PAY_APP_ID: "wx-test-app-id",
    WECHAT_PAY_MERCHANT_ID: "1900000109",
    WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL_NUMBER:
      MERCHANT_CERTIFICATE_SERIAL,
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64:
      encodePem(merchantKeyPair.privateKey),
    WECHAT_PAY_API_V3_KEY: API_V3_KEY,
    WECHAT_PAY_PUBLIC_KEY_ID: PLATFORM_KEY_ID,
    WECHAT_PAY_PUBLIC_KEY_BASE64:
      encodePem(platformKeyPair.publicKey),
    NEXT_PUBLIC_REPRESENTATIVE_URL:
      "https://reps.delegate.example",
    ...overrides,
  };
}

function encodePem(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function generateRsaKeyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
}

function signedResponse(rawBody: string): Response {
  return new Response(rawBody, {
    status: 200,
    headers: signedHeaders(rawBody),
  });
}

function signedHeaders(
  rawBody: string,
  options: {
    timestamp?: string;
    nonce?: string;
    serial?: string;
    privateKey?: string;
  } = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? FIXED_TIMESTAMP;
  const nonce = options.nonce ?? "platform-response-nonce";
  const serial = options.serial ?? PLATFORM_KEY_ID;
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const signature = signRsa(
    "RSA-SHA256",
    Buffer.from(message, "utf8"),
    options.privateKey ?? platformKeyPair.privateKey,
  ).toString("base64");
  return {
    "Wechatpay-Timestamp": timestamp,
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": serial,
    "Wechatpay-Signature": signature,
    "Wechatpay-Signature-Type": "WECHATPAY2-SHA256-RSA2048",
  };
}

function validRefundResource(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mchid: "1900000109",
    out_trade_no: "recharge_refund_001",
    transaction_id: "4200000000202607270000000099",
    out_refund_no: "refund_recharge_refund_001",
    refund_id: "5000000000202607270000000001",
    refund_status: "SUCCESS",
    success_time: "2026-07-27T16:00:02+08:00",
    user_received_account: "支付用户零钱",
    amount: {
      total: 3_600,
      refund: 1_200,
      payer_total: 3_200,
      payer_refund: 1_000,
    },
    ...overrides,
  };
}

function createSignedNotification(
  transaction: Record<string, unknown>,
): { rawBody: string; headers: Record<string, string> } {
  return createEncryptedNotification(transaction, {
    eventId: "EV-20260727-0001",
    eventType: "TRANSACTION.SUCCESS",
    originalType: "transaction",
    summary: "支付成功",
    associatedData: "transaction",
  });
}

function createSignedRefundNotification(
  refund: Record<string, unknown>,
  overrides: Partial<{
    eventId: string;
    eventType: string;
    originalType: string;
    createTime: string;
    summary: string;
    associatedData: string;
  }> = {},
): { rawBody: string; headers: Record<string, string> } {
  return createEncryptedNotification(refund, {
    eventId: "EV-REFUND-20260727-0001",
    eventType: "REFUND.SUCCESS",
    originalType: "refund",
    summary: "退款成功",
    associatedData: "refund",
    ...overrides,
  });
}

function createEncryptedNotification(
  decryptedResource: Record<string, unknown>,
  options: {
    eventId: string;
    eventType: string;
    originalType: string;
    summary: string;
    associatedData: string;
    createTime?: string;
  },
): { rawBody: string; headers: Record<string, string> } {
  const resourceNonce = "resourceiv12";
  const plaintext = JSON.stringify(decryptedResource);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(API_V3_KEY, "utf8"),
    Buffer.from(resourceNonce, "utf8"),
  );
  cipher.setAAD(Buffer.from(options.associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const rawBody = JSON.stringify({
    id: options.eventId,
    create_time:
      options.createTime ?? "2026-07-27T16:00:01+08:00",
    resource_type: "encrypt-resource",
    event_type: options.eventType,
    summary: options.summary,
    resource: {
      original_type: options.originalType,
      algorithm: "AEAD_AES_256_GCM",
      ciphertext,
      associated_data: options.associatedData,
      nonce: resourceNonce,
    },
  });
  return {
    rawBody,
    headers: signedHeaders(rawBody, {
      nonce: "platform-notification-nonce",
    }),
  };
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Expected ${name} header.`);
  }
  return value;
}

function requiredAuthorizationField(
  authorization: string,
  field: string,
): string {
  const match = authorization.match(new RegExp(`${field}="([^"]+)"`));
  if (!match?.[1]) {
    throw new Error(`Expected ${field} in Authorization header.`);
  }
  return match[1];
}
