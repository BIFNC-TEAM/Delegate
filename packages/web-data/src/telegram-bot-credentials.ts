import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const telegramTokenPattern = /^([1-9]\d{5,19}):([A-Za-z0-9_-]{20,200})$/;
const credentialAlgorithm = "aes-256-gcm";
const credentialIvBytes = 12;
const credentialAuthTagBytes = 16;
const credentialKeyBytes = 32;

export const LOCAL_DEVELOPMENT_CHANNEL_CREDENTIAL_MASTER_KEY =
  "bG9jYWwtZGVsZWdhdGUtY2hhbm5lbC1rZXktMDAwMSE=";

export type TelegramBotTokenIdentity = {
  botId: string;
};

export type EncryptedTelegramBotCredential = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
  algorithm: typeof credentialAlgorithm;
  fingerprint: string;
};

export type StoredTelegramBotCredential = {
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  keyVersion: string;
  algorithm: string;
  fingerprint: string;
};

export class TelegramBotCredentialError extends Error {
  readonly code:
    | "INVALID_TOKEN"
    | "MISSING_KEY"
    | "INVALID_KEY"
    | "UNAVAILABLE_CREDENTIAL"
    | "UNSUPPORTED_CREDENTIAL"
    | "DECRYPTION_FAILED";

  constructor(
    code: TelegramBotCredentialError["code"],
    message: string,
  ) {
    super(message);
    this.name = "TelegramBotCredentialError";
    this.code = code;
  }
}

export function parseTelegramBotTokenIdentity(
  token: string,
): TelegramBotTokenIdentity {
  const normalized = token.trim();
  const match = telegramTokenPattern.exec(normalized);
  if (!match) {
    throw new TelegramBotCredentialError(
      "INVALID_TOKEN",
      "Telegram Bot token format is invalid.",
    );
  }
  return { botId: match[1]! };
}

export function encryptTelegramBotToken(
  input: {
    token: string;
    telegramBotConnectionId: string;
    botId: string;
    credentialVersion: number;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): EncryptedTelegramBotCredential {
  const token = input.token.trim();
  const identity = parseTelegramBotTokenIdentity(token);
  const botId = normalizeBotId(input.botId);
  if (identity.botId !== botId) {
    throw new TelegramBotCredentialError(
      "INVALID_TOKEN",
      "Telegram Bot token does not match the verified Bot identity.",
    );
  }
  const connectionId = normalizeConnectionId(input.telegramBotConnectionId);
  const credentialVersion = normalizeCredentialVersion(input.credentialVersion);
  const { key, keyVersion } = resolveTelegramCredentialMasterKey(env);
  const iv = randomBytes(credentialIvBytes);
  const cipher = createCipheriv(credentialAlgorithm, key, iv, {
    authTagLength: credentialAuthTagBytes,
  });
  cipher.setAAD(
    buildCredentialAad(connectionId, botId, credentialVersion),
  );
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion,
    algorithm: credentialAlgorithm,
    fingerprint: fingerprintTelegramBotToken(token, key),
  };
}

export function decryptTelegramBotToken(
  input: {
    credential: StoredTelegramBotCredential;
    telegramBotConnectionId: string;
    botId: string;
    credentialVersion: number;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const connectionId = normalizeConnectionId(input.telegramBotConnectionId);
  const botId = normalizeBotId(input.botId);
  const credentialVersion = normalizeCredentialVersion(input.credentialVersion);
  const credential = input.credential;
  if (!credential.ciphertext || !credential.iv || !credential.authTag) {
    throw new TelegramBotCredentialError(
      "UNAVAILABLE_CREDENTIAL",
      "Telegram Bot credential is unavailable.",
    );
  }
  if (credential.algorithm !== credentialAlgorithm) {
    throw new TelegramBotCredentialError(
      "UNSUPPORTED_CREDENTIAL",
      "Telegram Bot credential uses an unsupported encryption algorithm.",
    );
  }
  const { key, keyVersion } = resolveTelegramCredentialMasterKey(env);
  if (credential.keyVersion !== keyVersion) {
    throw new TelegramBotCredentialError(
      "UNSUPPORTED_CREDENTIAL",
      "Telegram Bot credential requires an unavailable key version.",
    );
  }
  const iv = Buffer.from(credential.iv);
  const authTag = Buffer.from(credential.authTag);
  if (
    iv.length !== credentialIvBytes
    || authTag.length !== credentialAuthTagBytes
  ) {
    throw new TelegramBotCredentialError(
      "DECRYPTION_FAILED",
      "Telegram Bot credential could not be decrypted.",
    );
  }

  try {
    const decipher = createDecipheriv(credentialAlgorithm, key, iv, {
      authTagLength: credentialAuthTagBytes,
    });
    decipher.setAAD(
      buildCredentialAad(connectionId, botId, credentialVersion),
    );
    decipher.setAuthTag(authTag);
    const token = Buffer.concat([
      decipher.update(Buffer.from(credential.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    const identity = parseTelegramBotTokenIdentity(token);
    const expectedFingerprint = fingerprintTelegramBotToken(token, key);
    if (
      identity.botId !== botId
      || !safeEqualHex(expectedFingerprint, credential.fingerprint)
    ) {
      throw new Error("credential identity mismatch");
    }
    return token;
  } catch {
    throw new TelegramBotCredentialError(
      "DECRYPTION_FAILED",
      "Telegram Bot credential could not be decrypted.",
    );
  }
}

export function fingerprintTelegramBotToken(
  token: string,
  keyOrEnv:
    | Uint8Array
    | Readonly<Record<string, string | undefined>> = process.env,
): string {
  const normalized = token.trim();
  parseTelegramBotTokenIdentity(normalized);
  const key = keyOrEnv instanceof Uint8Array
    ? Buffer.from(keyOrEnv)
    : resolveTelegramCredentialMasterKey(keyOrEnv).key;
  return createHmac("sha256", key)
    .update("delegate:telegram-bot-token:v1\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

export function resolveTelegramCredentialMasterKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { key: Buffer; keyVersion: string } {
  const encoded = env.CHANNEL_CREDENTIAL_MASTER_KEY?.trim();
  if (!encoded) {
    throw new TelegramBotCredentialError(
      "MISSING_KEY",
      env.NODE_ENV === "production"
        ? "CHANNEL_CREDENTIAL_MASTER_KEY is required in production."
        : "CHANNEL_CREDENTIAL_MASTER_KEY must be explicitly configured.",
    );
  }
  const key = decodeStrictBase64(encoded);
  if (!key || key.length !== credentialKeyBytes) {
    throw new TelegramBotCredentialError(
      "INVALID_KEY",
      "CHANNEL_CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key.",
    );
  }
  if (
    env.NODE_ENV === "production"
    && encoded === LOCAL_DEVELOPMENT_CHANNEL_CREDENTIAL_MASTER_KEY
  ) {
    throw new TelegramBotCredentialError(
      "INVALID_KEY",
      "CHANNEL_CREDENTIAL_MASTER_KEY must be unique in production.",
    );
  }
  const keyVersion =
    env.CHANNEL_CREDENTIAL_MASTER_KEY_VERSION?.trim() || "v1";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyVersion)) {
    throw new TelegramBotCredentialError(
      "INVALID_KEY",
      "CHANNEL_CREDENTIAL_MASTER_KEY_VERSION is invalid.",
    );
  }
  return { key, keyVersion };
}

function buildCredentialAad(
  connectionId: string,
  botId: string,
  credentialVersion: number,
) {
  return Buffer.from(
    [
      "delegate",
      "telegram-bot-credential",
      "v1",
      connectionId,
      String(credentialVersion),
      botId,
    ].join(":"),
    "utf8",
  );
}

function normalizeConnectionId(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191 || normalized.includes("\0")) {
    throw new TelegramBotCredentialError(
      "UNAVAILABLE_CREDENTIAL",
      "Telegram Bot connection identity is invalid.",
    );
  }
  return normalized;
}

function normalizeBotId(value: string) {
  const normalized = value.trim();
  if (!/^[1-9]\d{5,19}$/.test(normalized)) {
    throw new TelegramBotCredentialError(
      "INVALID_TOKEN",
      "Telegram Bot identity is invalid.",
    );
  }
  return normalized;
}

function normalizeCredentialVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TelegramBotCredentialError(
      "UNAVAILABLE_CREDENTIAL",
      "Telegram Bot credential version is invalid.",
    );
  }
  return value;
}

function decodeStrictBase64(encoded: string): Buffer | null {
  if (
    encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded ? decoded : null;
}

function safeEqualHex(left: string, right: string) {
  if (
    !/^[a-f0-9]{64}$/.test(left)
    || !/^[a-f0-9]{64}$/.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex"),
  );
}
