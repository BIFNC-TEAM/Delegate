import { describe, expect, it, vi } from "vitest";

import {
  isWeChatPayCollectionEnabled,
  isWeChatPayProcessingEnabled,
  preflightWeChatPayRuntime,
  resolveWeChatPayReleaseFlags,
} from "../src/wechat-pay-release-flags";

describe("WeChat Pay release flags", () => {
  it("keeps collection and processing disabled by default", () => {
    expect(resolveWeChatPayReleaseFlags({})).toEqual({
      collectionEnabled: false,
      processingEnabled: false,
      legacyFallbackUsed: true,
    });
  });

  it("uses the legacy flag only when both split flags are absent", () => {
    expect(
      resolveWeChatPayReleaseFlags({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
      }),
    ).toMatchObject({
      collectionEnabled: true,
      processingEnabled: true,
    });
    expect(
      resolveWeChatPayReleaseFlags({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
      }),
    ).toMatchObject({
      collectionEnabled: false,
      processingEnabled: true,
      legacyFallbackUsed: false,
    });
    expect(
      resolveWeChatPayReleaseFlags({
        DELEGATE_WECHAT_PAY_ENABLED: "true",
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "",
      }),
    ).toMatchObject({
      collectionEnabled: true,
      processingEnabled: true,
      legacyFallbackUsed: true,
    });
  });

  it("rejects a partial split-flag deployment instead of falling back to legacy collection", () => {
    for (const env of [
      {
        DELEGATE_WECHAT_PAY_ENABLED: "true",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
      },
      {
        DELEGATE_WECHAT_PAY_ENABLED: "true",
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
      },
    ]) {
      expect(() => resolveWeChatPayReleaseFlags(env)).toThrow(
        "must be configured together",
      );
      expect(isWeChatPayCollectionEnabled(env)).toBe(false);
      expect(isWeChatPayProcessingEnabled(env)).toBe(false);
    }
  });

  it("rejects non-boolean flag spellings instead of silently disabling processing", () => {
    for (const env of [
      {
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "TRUE",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "false",
      },
      {
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "tru",
      },
      {
        DELEGATE_WECHAT_PAY_ENABLED: "1",
      },
    ]) {
      expect(() => resolveWeChatPayReleaseFlags(env)).toThrow(
        'must be exactly "true" or "false"',
      );
      expect(isWeChatPayCollectionEnabled(env)).toBe(false);
      expect(isWeChatPayProcessingEnabled(env)).toBe(false);
      expect(preflightWeChatPayRuntime(env)).toMatchObject({
        ready: false,
        status: "misconfigured",
        errorCode: "wechat_pay_release_flags_invalid",
      });
    }
  });

  it("rejects collection without durable processing and gates fail closed", () => {
    const env = {
      DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "true",
      DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "false",
    };

    expect(() => resolveWeChatPayReleaseFlags(env)).toThrow(
      "requires DELEGATE_WECHAT_PAY_PROCESSING_ENABLED=true",
    );
    expect(isWeChatPayCollectionEnabled(env)).toBe(false);
    expect(isWeChatPayProcessingEnabled(env)).toBe(false);
  });
});

describe("WeChat Pay runtime preflight", () => {
  it("does not require credentials while processing is disabled", () => {
    const loadConfig = vi.fn();

    expect(
      preflightWeChatPayRuntime({}, { loadConfig }),
    ).toEqual({
      ready: true,
      status: "disabled",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: null,
    });
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("validates processing-only configuration without network activity", () => {
    const config = { fetch: vi.fn() };
    const loadConfig = vi.fn(() => config as never);
    const validateConfig = vi.fn();

    expect(
      preflightWeChatPayRuntime(
        {
          DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
          DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
        },
        { loadConfig, validateConfig },
      ),
    ).toEqual({
      ready: true,
      status: "ready",
      collectionEnabled: false,
      processingEnabled: true,
      errorCode: null,
    });
    expect(validateConfig).toHaveBeenCalledWith(config);
    expect(config.fetch).not.toHaveBeenCalled();
  });

  it("returns only a stable code when credential validation fails", () => {
    const snapshot = preflightWeChatPayRuntime(
      {
        DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "false",
        DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "true",
      },
      {
        loadConfig: () => {
          throw new Error("private-key-secret");
        },
      },
    );

    expect(snapshot).toEqual({
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: true,
      errorCode: "wechat_pay_configuration_invalid",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-key-secret");
  });

  it("reports an invalid release combination without loading credentials", () => {
    const loadConfig = vi.fn();

    expect(
      preflightWeChatPayRuntime(
        {
          DELEGATE_WECHAT_PAY_COLLECTION_ENABLED: "true",
          DELEGATE_WECHAT_PAY_PROCESSING_ENABLED: "false",
        },
        { loadConfig },
      ),
    ).toEqual({
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: "wechat_pay_release_flags_invalid",
    });
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
