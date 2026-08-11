import { describe, expect, it } from "vitest";

import { loadWeChatPayPrivateBridgeConfig } from "../wechat-pay-private-bridge.mjs";

describe("WeChat Pay private callback bridge", () => {
  it("accepts a private listener and loopback target", () => {
    expect(
      loadWeChatPayPrivateBridgeConfig({
        WECHAT_PAY_CALLBACK_BRIDGE_HOST: "172.19.23.197",
        WECHAT_PAY_CALLBACK_BRIDGE_PORT: "4303",
        WECHAT_PAY_CALLBACK_BRIDGE_TARGET_HOST: "127.0.0.1",
        WECHAT_PAY_CALLBACK_BRIDGE_TARGET_PORT: "4302",
      }),
    ).toEqual({
      listenHost: "172.19.23.197",
      listenPort: 4303,
      targetHost: "127.0.0.1",
      targetPort: 4302,
    });
  });

  it("rejects public listeners and non-loopback targets", () => {
    expect(() =>
      loadWeChatPayPrivateBridgeConfig({
        WECHAT_PAY_CALLBACK_BRIDGE_HOST: "0.0.0.0",
      }),
    ).toThrow("loopback or a private IPv4 address");
    expect(() =>
      loadWeChatPayPrivateBridgeConfig({
        WECHAT_PAY_CALLBACK_BRIDGE_TARGET_HOST: "172.19.23.197",
      }),
    ).toThrow("must be a loopback hostname");
  });
});
