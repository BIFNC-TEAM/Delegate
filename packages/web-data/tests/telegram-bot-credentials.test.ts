import { describe, expect, it } from "vitest";

import {
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  LOCAL_DEVELOPMENT_CHANNEL_CREDENTIAL_MASTER_KEY,
  parseTelegramBotTokenIdentity,
  resolveTelegramCredentialMasterKey,
  TelegramBotCredentialError,
} from "../src/telegram-bot-credentials";

const token = "1234567890:abcdefghijklmnopqrstuvwxyzABCDE_12345";
const masterKey = Buffer.alloc(32, 7).toString("base64");
const env = {
  NODE_ENV: "test",
  CHANNEL_CREDENTIAL_MASTER_KEY: masterKey,
  CHANNEL_CREDENTIAL_MASTER_KEY_VERSION: "test-v1",
};

describe("Telegram Bot credentials", () => {
  it("encrypts a token with connection-bound authenticated encryption", () => {
    const encrypted = encryptTelegramBotToken(
      {
        token,
        telegramBotConnectionId: "connection-1",
        botId: "1234567890",
        credentialVersion: 1,
      },
      env,
    );

    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(token);
    expect(encrypted.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      decryptTelegramBotToken(
        {
          credential: encrypted,
          telegramBotConnectionId: "connection-1",
          botId: "1234567890",
          credentialVersion: 1,
        },
        env,
      ),
    ).toBe(token);
  });

  it("rejects ciphertext moved to a different connection or version", () => {
    const encrypted = encryptTelegramBotToken(
      {
        token,
        telegramBotConnectionId: "connection-1",
        botId: "1234567890",
        credentialVersion: 1,
      },
      env,
    );

    expect(() =>
      decryptTelegramBotToken(
        {
          credential: encrypted,
          telegramBotConnectionId: "connection-2",
          botId: "1234567890",
          credentialVersion: 1,
        },
        env,
      )
    ).toThrow("could not be decrypted");
    expect(() =>
      decryptTelegramBotToken(
        {
          credential: encrypted,
          telegramBotConnectionId: "connection-1",
          botId: "1234567890",
          credentialVersion: 2,
        },
        env,
      )
    ).toThrow("could not be decrypted");
  });

  it("fails closed without an explicit 32-byte master key", () => {
    for (const candidate of [
      { NODE_ENV: "production" },
      {
        NODE_ENV: "test",
        DELEGATE_AUTH_SESSION_SECRET: Buffer.alloc(32, 1).toString("base64"),
      },
      {
        NODE_ENV: "test",
        CHANNEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(31, 1).toString("base64"),
      },
    ]) {
      expect(() => resolveTelegramCredentialMasterKey(candidate)).toThrow(
        TelegramBotCredentialError,
      );
    }
  });

  it("rejects the repository-known local key in production only", () => {
    expect(
      resolveTelegramCredentialMasterKey({
        NODE_ENV: "development",
        CHANNEL_CREDENTIAL_MASTER_KEY:
          LOCAL_DEVELOPMENT_CHANNEL_CREDENTIAL_MASTER_KEY,
      }).key,
    ).toHaveLength(32);

    expect(() =>
      resolveTelegramCredentialMasterKey({
        NODE_ENV: "production",
        CHANNEL_CREDENTIAL_MASTER_KEY:
          LOCAL_DEVELOPMENT_CHANNEL_CREDENTIAL_MASTER_KEY,
      })
    ).toThrow("must be unique in production");
  });

  it("validates the numeric token prefix without exposing the secret", () => {
    expect(parseTelegramBotTokenIdentity(token)).toEqual({
      botId: "1234567890",
    });
    for (const invalid of [
      "not-a-token",
      "012345:abcdefghijklmnopqrstuvwxyzABCDE_12345",
      "123456:short",
    ]) {
      expect(() => parseTelegramBotTokenIdentity(invalid)).toThrow(
        "format is invalid",
      );
    }
  });
});
