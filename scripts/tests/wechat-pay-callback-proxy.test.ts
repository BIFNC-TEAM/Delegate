import { describe, expect, it } from "vitest";

import {
  isAllowedWeChatPayCallbackTarget,
  loadWeChatPayCallbackProxyConfig,
} from "../wechat-pay-callback-proxy";

describe("WeChat Pay callback-only proxy", () => {
  it("allows only the two exact POST callback targets", () => {
    expect(
      isAllowedWeChatPayCallbackTarget(
        "POST",
        "/api/payments/wechat/notify",
      ),
    ).toBe(true);
    expect(
      isAllowedWeChatPayCallbackTarget(
        "POST",
        "/api/payments/wechat/refund-notify",
      ),
    ).toBe(true);
    expect(
      isAllowedWeChatPayCallbackTarget(
        "GET",
        "/api/payments/wechat/notify",
      ),
    ).toBe(false);
    expect(
      isAllowedWeChatPayCallbackTarget(
        "POST",
        "/api/payments/wechat/notify?token=unsafe",
      ),
    ).toBe(false);
    expect(
      isAllowedWeChatPayCallbackTarget("POST", "/reps/delegate"),
    ).toBe(false);
  });

  it("accepts only an origin-only loopback HTTP upstream", () => {
    expect(
      loadWeChatPayCallbackProxyConfig({
        WECHAT_PAY_CALLBACK_PROXY_PORT: "4303",
        WECHAT_PAY_CALLBACK_PROXY_UPSTREAM: "http://127.0.0.1:3002",
      }),
    ).toMatchObject({
      listenPort: 4303,
      upstream: expect.objectContaining({
        origin: "http://127.0.0.1:3002",
      }),
    });
    expect(() =>
      loadWeChatPayCallbackProxyConfig({
        WECHAT_PAY_CALLBACK_PROXY_UPSTREAM: "https://example.com",
      }),
    ).toThrow("origin-only loopback HTTP URL");
    expect(() =>
      loadWeChatPayCallbackProxyConfig({
        WECHAT_PAY_CALLBACK_PROXY_UPSTREAM:
          "http://127.0.0.1:3002/api/payments/wechat/notify",
      }),
    ).toThrow("origin-only loopback HTTP URL");
  });
});
