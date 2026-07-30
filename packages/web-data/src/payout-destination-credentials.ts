import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const credentialAlgorithm = "aes-256-gcm";
const credentialIvBytes = 12;
const credentialAuthTagBytes = 16;
const credentialKeyBytes = 32;
const maximumRecipientTokenBytes = 4_096;

export const LOCAL_DEVELOPMENT_PAYOUT_CREDENTIAL_MASTER_KEY =
  "bG9jYWwtZGVsZWdhdGUtcGF5b3V0LWtleS0wMDAwMSE=";

export type PayoutDestinationProvider = "WECHAT_PAY";

export type EncryptedPayoutDestinationCredential = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
  algorithm: typeof credentialAlgorithm;
  fingerprint: string;
};

export type StoredPayoutDestinationCredential = {
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  keyVersion: string;
  algorithm: string;
  fingerprint: string;
};

export class PayoutDestinationCredentialError extends Error {
  readonly code:
    | "INVALID_TOKEN"
    | "INVALID_COORDINATES"
    | "MISSING_KEY"
    | "INVALID_KEY"
    | "UNAVAILABLE_CREDENTIAL"
    | "UNSUPPORTED_CREDENTIAL"
    | "DECRYPTION_FAILED";

  constructor(
    code: PayoutDestinationCredentialError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PayoutDestinationCredentialError";
    this.code = code;
  }
}

export function encryptPayoutDestinationToken(
  input: {
    recipientToken: string;
    payoutProfileId: string;
    payoutDestinationId: string;
    credentialVersion: number;
    provider: PayoutDestinationProvider;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): EncryptedPayoutDestinationCredential {
  const recipientToken = normalizeRecipientToken(input.recipientToken);
  const coordinates = normalizeCredentialCoordinates(input);
  const { key, keyVersion } = resolvePayoutCredentialMasterKey(env);
  const iv = randomBytes(credentialIvBytes);
  const cipher = createCipheriv(credentialAlgorithm, key, iv, {
    authTagLength: credentialAuthTagBytes,
  });
  cipher.setAAD(buildCredentialAad(coordinates));
  const ciphertext = Buffer.concat([
    cipher.update(recipientToken, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion,
    algorithm: credentialAlgorithm,
    fingerprint: fingerprintPayoutDestinationToken(recipientToken, key),
  };
}

export function decryptPayoutDestinationToken(
  input: {
    credential: StoredPayoutDestinationCredential;
    payoutProfileId: string;
    payoutDestinationId: string;
    credentialVersion: number;
    provider: PayoutDestinationProvider;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const coordinates = normalizeCredentialCoordinates(input);
  const credential = input.credential;
  if (!credential.ciphertext || !credential.iv || !credential.authTag) {
    throw new PayoutDestinationCredentialError(
      "UNAVAILABLE_CREDENTIAL",
      "Payout destination credential is unavailable.",
    );
  }
  if (credential.algorithm !== credentialAlgorithm) {
    throw new PayoutDestinationCredentialError(
      "UNSUPPORTED_CREDENTIAL",
      "Payout destination credential uses an unsupported encryption algorithm.",
    );
  }
  const { key, keyVersion } = resolvePayoutCredentialMasterKey(env);
  if (credential.keyVersion !== keyVersion) {
    throw new PayoutDestinationCredentialError(
      "UNSUPPORTED_CREDENTIAL",
      "Payout destination credential requires an unavailable key version.",
    );
  }
  const iv = Buffer.from(credential.iv);
  const authTag = Buffer.from(credential.authTag);
  if (
    iv.length !== credentialIvBytes
    || authTag.length !== credentialAuthTagBytes
  ) {
    throw new PayoutDestinationCredentialError(
      "DECRYPTION_FAILED",
      "Payout destination credential could not be decrypted.",
    );
  }

  try {
    const decipher = createDecipheriv(credentialAlgorithm, key, iv, {
      authTagLength: credentialAuthTagBytes,
    });
    decipher.setAAD(buildCredentialAad(coordinates));
    decipher.setAuthTag(authTag);
    const recipientToken = Buffer.concat([
      decipher.update(Buffer.from(credential.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    normalizeRecipientToken(recipientToken);
    const expectedFingerprint = fingerprintPayoutDestinationToken(
      recipientToken,
      key,
    );
    if (!safeEqualHex(expectedFingerprint, credential.fingerprint)) {
      throw new Error("credential fingerprint mismatch");
    }
    return recipientToken;
  } catch {
    throw new PayoutDestinationCredentialError(
      "DECRYPTION_FAILED",
      "Payout destination credential could not be decrypted.",
    );
  }
}

export function fingerprintPayoutDestinationToken(
  recipientToken: string,
  keyOrEnv:
    | Uint8Array
    | Readonly<Record<string, string | undefined>> = process.env,
): string {
  const normalized = normalizeRecipientToken(recipientToken);
  const key = keyOrEnv instanceof Uint8Array
    ? Buffer.from(keyOrEnv)
    : resolvePayoutCredentialMasterKey(keyOrEnv).key;
  return createHmac("sha256", key)
    .update("delegate:payout-destination-token:v1\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

export function resolvePayoutCredentialMasterKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { key: Buffer; keyVersion: string } {
  const encoded = env.PAYOUT_CREDENTIAL_MASTER_KEY?.trim();
  if (!encoded) {
    throw new PayoutDestinationCredentialError(
      "MISSING_KEY",
      env.NODE_ENV === "production"
        ? "PAYOUT_CREDENTIAL_MASTER_KEY is required in production."
        : "PAYOUT_CREDENTIAL_MASTER_KEY must be explicitly configured.",
    );
  }
  const key = decodeStrictBase64(encoded);
  if (!key || key.length !== credentialKeyBytes) {
    throw new PayoutDestinationCredentialError(
      "INVALID_KEY",
      "PAYOUT_CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key.",
    );
  }
  if (
    env.NODE_ENV === "production"
    && encoded === LOCAL_DEVELOPMENT_PAYOUT_CREDENTIAL_MASTER_KEY
  ) {
    throw new PayoutDestinationCredentialError(
      "INVALID_KEY",
      "PAYOUT_CREDENTIAL_MASTER_KEY must be unique in production.",
    );
  }
  const keyVersion =
    env.PAYOUT_CREDENTIAL_MASTER_KEY_VERSION?.trim() || "v1";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyVersion)) {
    throw new PayoutDestinationCredentialError(
      "INVALID_KEY",
      "PAYOUT_CREDENTIAL_MASTER_KEY_VERSION is invalid.",
    );
  }
  return { key, keyVersion };
}

function buildCredentialAad(input: {
  payoutProfileId: string;
  payoutDestinationId: string;
  credentialVersion: number;
  provider: PayoutDestinationProvider;
}) {
  return Buffer.from(
    JSON.stringify([
      "delegate",
      "payout-destination-credential",
      1,
      input.payoutProfileId,
      input.payoutDestinationId,
      input.credentialVersion,
      input.provider,
    ]),
    "utf8",
  );
}

function normalizeCredentialCoordinates(input: {
  payoutProfileId: string;
  payoutDestinationId: string;
  credentialVersion: number;
  provider: PayoutDestinationProvider;
}) {
  const payoutProfileId = normalizeCoordinate(
    input.payoutProfileId,
    "payout profile",
  );
  const payoutDestinationId = normalizeCoordinate(
    input.payoutDestinationId,
    "payout destination",
  );
  if (
    !Number.isSafeInteger(input.credentialVersion)
    || input.credentialVersion < 1
  ) {
    throw new PayoutDestinationCredentialError(
      "INVALID_COORDINATES",
      "Payout destination credential version is invalid.",
    );
  }
  if (input.provider !== "WECHAT_PAY") {
    throw new PayoutDestinationCredentialError(
      "INVALID_COORDINATES",
      "Payout destination provider is invalid.",
    );
  }
  return {
    payoutProfileId,
    payoutDestinationId,
    credentialVersion: input.credentialVersion,
    provider: input.provider,
  };
}

function normalizeCoordinate(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191 || normalized.includes("\0")) {
    throw new PayoutDestinationCredentialError(
      "INVALID_COORDINATES",
      `Payout destination ${label} identity is invalid.`,
    );
  }
  return normalized;
}

function normalizeRecipientToken(value: string) {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.includes("\0")
    || Buffer.byteLength(normalized, "utf8") > maximumRecipientTokenBytes
  ) {
    throw new PayoutDestinationCredentialError(
      "INVALID_TOKEN",
      "Payout destination recipient token is invalid.",
    );
  }
  return normalized;
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
