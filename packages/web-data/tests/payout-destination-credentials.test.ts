import { describe, expect, it } from "vitest";

import {
  LOCAL_DEVELOPMENT_PAYOUT_CREDENTIAL_MASTER_KEY,
  PayoutDestinationCredentialError,
  decryptPayoutDestinationToken,
  encryptPayoutDestinationToken,
  fingerprintPayoutDestinationToken,
  resolvePayoutCredentialMasterKey,
} from "../src/payout-destination-credentials";

const env = {
  NODE_ENV: "test",
  PAYOUT_CREDENTIAL_MASTER_KEY:
    "cGF5b3V0LWRlc3RpbmF0aW9uLWtleS0wMDAwMDAwMSE=",
  PAYOUT_CREDENTIAL_MASTER_KEY_VERSION: "test-v1",
};

const coordinates = {
  payoutProfileId: "profile-1",
  payoutDestinationId: "destination-1",
  credentialVersion: 1,
  provider: "WECHAT_PAY" as const,
};

describe("payout destination credentials", () => {
  it("encrypts a recipient token with authenticated destination coordinates", () => {
    const encrypted = encryptPayoutDestinationToken(
      {
        recipientToken: "provider-recipient-token-1",
        ...coordinates,
      },
      env,
    );

    expect(encrypted).toMatchObject({
      algorithm: "aes-256-gcm",
      keyVersion: "test-v1",
    });
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(
      "provider-recipient-token-1",
    );
    expect(encrypted.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      decryptPayoutDestinationToken(
        {
          credential: encrypted,
          ...coordinates,
        },
        env,
      ),
    ).toBe("provider-recipient-token-1");
  });

  it.each([
    ["profile", { payoutProfileId: "profile-2" }],
    ["destination", { payoutDestinationId: "destination-2" }],
    ["version", { credentialVersion: 2 }],
  ])("rejects decryption after the %s coordinate changes", (_label, change) => {
    const encrypted = encryptPayoutDestinationToken(
      {
        recipientToken: "provider-recipient-token-1",
        ...coordinates,
      },
      env,
    );

    expect(() =>
      decryptPayoutDestinationToken(
        {
          credential: encrypted,
          ...coordinates,
          ...change,
        },
        env,
      ),
    ).toThrowError(PayoutDestinationCredentialError);
  });

  it("rejects tampered ciphertext and fingerprint evidence", () => {
    const encrypted = encryptPayoutDestinationToken(
      {
        recipientToken: "provider-recipient-token-1",
        ...coordinates,
      },
      env,
    );
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] = tampered[0]! ^ 1;

    expect(() =>
      decryptPayoutDestinationToken(
        {
          credential: {
            ...encrypted,
            ciphertext: tampered,
          },
          ...coordinates,
        },
        env,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DECRYPTION_FAILED",
      }),
    );
    expect(() =>
      decryptPayoutDestinationToken(
        {
          credential: {
            ...encrypted,
            fingerprint: "0".repeat(64),
          },
          ...coordinates,
        },
        env,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DECRYPTION_FAILED",
      }),
    );
  });

  it("uses a keyed, deterministic fingerprint without exposing the token", () => {
    const left = fingerprintPayoutDestinationToken(
      "provider-recipient-token-1",
      env,
    );
    const replay = fingerprintPayoutDestinationToken(
      "provider-recipient-token-1",
      env,
    );
    const other = fingerprintPayoutDestinationToken(
      "provider-recipient-token-2",
      env,
    );

    expect(left).toBe(replay);
    expect(left).not.toBe(other);
    expect(left).not.toContain("provider-recipient-token");
  });

  it("fails closed for missing, malformed, or unsafe production keys", () => {
    expect(() => resolvePayoutCredentialMasterKey({ NODE_ENV: "test" }))
      .toThrowError(expect.objectContaining({ code: "MISSING_KEY" }));
    expect(() =>
      resolvePayoutCredentialMasterKey({
        NODE_ENV: "test",
        PAYOUT_CREDENTIAL_MASTER_KEY: "not-base64",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_KEY" }));
    expect(() =>
      resolvePayoutCredentialMasterKey({
        NODE_ENV: "production",
        PAYOUT_CREDENTIAL_MASTER_KEY:
          LOCAL_DEVELOPMENT_PAYOUT_CREDENTIAL_MASTER_KEY,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_KEY" }));
  });

  it("rejects empty, oversized, and unsupported credential inputs", () => {
    expect(() =>
      encryptPayoutDestinationToken(
        {
          recipientToken: " ",
          ...coordinates,
        },
        env,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() =>
      encryptPayoutDestinationToken(
        {
          recipientToken: "x".repeat(4_097),
          ...coordinates,
        },
        env,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() =>
      encryptPayoutDestinationToken(
        {
          recipientToken: "provider-recipient-token-1",
          ...coordinates,
          provider: "BANK" as "WECHAT_PAY",
        },
        env,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_COORDINATES" }));
  });
});
