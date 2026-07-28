import { createHash, randomUUID } from "node:crypto";

import {
  ChannelDesiredState,
  ChannelHealthStatus,
  EventType,
  RepresentativeChannelKind,
  TelegramBotConnectionScope,
  TelegramBotConnectionStatus,
  TelegramBotCredentialStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import {
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  fingerprintTelegramBotToken,
  parseTelegramBotTokenIdentity,
  TelegramBotCredentialError,
} from "./telegram-bot-credentials";

const getMeTimeoutMs = 10_000;
const safeOperationToken = /^[A-Za-z0-9._:-]{1,191}$/;
const telegramUsernamePattern = /^[A-Za-z0-9_]{5,32}$/;
const ownerTelegramBotAuditScope = "OWNER_TELEGRAM_BOT";
const ownerTelegramBotIdempotencyConflictMessage =
  "Idempotency key was already used for a different Telegram Bot request on this resource.";

export type OwnerTelegramBotConnection = {
  id: string;
  botId: string;
  username: string | null;
  displayName: string | null;
  label: string | null;
  status: "PENDING_CREDENTIAL" | "ACTIVE" | "DISABLED" | "REVOKED";
  healthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  verificationStatus: "PENDING" | "VERIFIED";
  lastVerifiedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  credentialRevision: number;
  referenceCount: number;
  activeReferenceCount: number;
};

export type OwnerTelegramBotConnectionSummary =
  OwnerTelegramBotConnection;

export type TelegramBotRuntimeCredential = {
  connectionId: string;
  botId: string;
  username: string | null;
  displayName: string | null;
  token: string;
  credentialRevision: number;
};

export type TelegramBotRuntimeDescriptor = Omit<
  TelegramBotRuntimeCredential,
  "token"
>;

export type OwnerTelegramBotLifecycleResult = {
  connection: OwnerTelegramBotConnection;
  changed: boolean;
  replayed: boolean;
};

export type OwnerTelegramBotRotationResult =
  OwnerTelegramBotLifecycleResult & {
    rotated: boolean;
  };

export type OwnerTelegramBotUnassignmentResult = {
  binding: {
    id: string;
    representativeId: string;
    telegramBotConnectionId: string | null;
    connectionId: string | null;
    desiredState: "ACTIVE" | "PAUSED" | "DISCONNECTED";
    status: string;
  };
  changed: boolean;
  replayed: boolean;
};

export class TelegramBotConnectionError extends Error {
  readonly statusCode: 400 | 404 | 409 | 503;

  constructor(
    message: string,
    statusCode: TelegramBotConnectionError["statusCode"],
  ) {
    super(message);
    this.name = "TelegramBotConnectionError";
    this.statusCode = statusCode;
  }
}

type TelegramBotConnectionDependencies = {
  client?: typeof prisma;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: Date;
};

type VerifiedTelegramBot = {
  botId: string;
  username: string | null;
  displayName: string | null;
};

const ownerConnectionSelect = {
  id: true,
  botId: true,
  username: true,
  displayName: true,
  label: true,
  status: true,
  healthStatus: true,
  lastVerifiedAt: true,
  lastHealthCheckAt: true,
  lastError: true,
  credentialRevision: true,
  representativeBindings: {
    select: {
      desiredState: true,
    },
  },
} as const;

const ownerLifecycleConnectionSelect = {
  ...ownerConnectionSelect,
  ownerId: true,
  scope: true,
  activeCredentialId: true,
  revokedAt: true,
  activeCredential: {
    select: {
      id: true,
      version: true,
      fingerprint: true,
      status: true,
    },
  },
} as const;

const ownerTelegramBindingSelect = {
  id: true,
  representativeId: true,
  connectionId: true,
  telegramBotConnectionId: true,
  desiredState: true,
  status: true,
} as const;

export async function createOrRotateOwnerTelegramBotConnection(
  input: {
    ownerId: string;
    actorId: string;
    token: string;
    label?: string | null;
    requestId: string;
    idempotencyKey: string;
  },
  dependencies: TelegramBotConnectionDependencies = {},
): Promise<{
  connection: OwnerTelegramBotConnection;
  created: boolean;
  rotated: boolean;
}> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const actorId = requireText(input.actorId, "actorId");
  const requestId = normalizeOperationToken(input.requestId, "requestId");
  const idempotencyKey = normalizeOperationToken(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const token = input.token.trim();
  let tokenIdentity: ReturnType<typeof parseTelegramBotTokenIdentity>;
  try {
    tokenIdentity = parseTelegramBotTokenIdentity(token);
  } catch (error) {
    throw normalizeConnectionError(error);
  }
  const label = normalizeOptionalLabel(input.label);
  const client = dependencies.client ?? prisma;
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? new Date();
  const verified = await verifyTelegramBotToken(
    token,
    dependencies.fetchImpl ?? fetch,
  );
  if (verified.botId !== tokenIdentity.botId) {
    throw new TelegramBotConnectionError(
      "Telegram Bot token does not match the verified Bot identity.",
      400,
    );
  }

  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${"telegram-bot-connection:" + verified.botId})
        )
      `;
      const owner = await tx.owner.findUnique({
        where: { id: ownerId },
        select: { id: true },
      });
      if (!owner) {
        throw new TelegramBotConnectionError("Owner not found.", 404);
      }

      const existing = await tx.telegramBotConnection.findUnique({
        where: { botId: verified.botId },
        include: {
          activeCredential: true,
          credentials: {
            where: { idempotencyKey },
            orderBy: { version: "desc" },
            take: 1,
          },
          representativeBindings: {
            select: { desiredState: true },
          },
        },
      });
      if (
        existing
        && (
          existing.scope !== TelegramBotConnectionScope.OWNER_MANAGED
          || existing.ownerId !== ownerId
        )
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection is unavailable.",
          409,
        );
      }
      if (
        existing
        && (
          existing.status === TelegramBotConnectionStatus.REVOKED
          || existing.revokedAt
        )
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection has been revoked.",
          409,
        );
      }

      if (!existing) {
        const connectionId = randomUUID();
        const credentialVersion = 1;
        const encrypted = encryptTelegramBotToken(
          {
            token,
            telegramBotConnectionId: connectionId,
            botId: verified.botId,
            credentialVersion,
          },
          env,
        );
        const connection = await tx.telegramBotConnection.create({
          data: {
            id: connectionId,
            ownerId,
            scope: TelegramBotConnectionScope.OWNER_MANAGED,
            botId: verified.botId,
            username: verified.username,
            displayName: verified.displayName,
            label,
            status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
            healthStatus: ChannelHealthStatus.UNKNOWN,
            credentialRevision: 0,
            lastVerifiedAt: now,
          },
          select: { id: true },
        });
        const credential = await tx.telegramBotCredential.create({
          data: {
            telegramBotConnectionId: connection.id,
            version: credentialVersion,
            ciphertext: Uint8Array.from(encrypted.ciphertext),
            iv: Uint8Array.from(encrypted.iv),
            authTag: Uint8Array.from(encrypted.authTag),
            keyVersion: encrypted.keyVersion,
            algorithm: encrypted.algorithm,
            fingerprint: encrypted.fingerprint,
            status: TelegramBotCredentialStatus.ACTIVE,
            createdBy: actorId,
            requestId,
            idempotencyKey,
            activatedAt: now,
          },
          select: { id: true },
        });
        const activated = await tx.telegramBotConnection.update({
          where: { id: connection.id },
          data: {
            activeCredentialId: credential.id,
            credentialRevision: credentialVersion,
            status: TelegramBotConnectionStatus.ACTIVE,
            lastVerifiedAt: now,
            lastError: null,
          },
          select: ownerConnectionSelect,
        });
        return {
          connection: serializeOwnerConnection(activated),
          created: true,
          rotated: false,
        };
      }

      const fingerprint = fingerprintTelegramBotToken(token, env);
      const repeatedCredential = existing.credentials[0] ?? null;
      if (
        repeatedCredential
        && repeatedCredential.fingerprint !== fingerprint
      ) {
        throw new TelegramBotConnectionError(
          "Idempotency key was already used for a different Telegram Bot credential.",
          409,
        );
      }
      if (
        repeatedCredential
        && existing.label !== (input.label === undefined ? null : label)
      ) {
        throw new TelegramBotConnectionError(
          ownerTelegramBotIdempotencyConflictMessage,
          409,
        );
      }
      const activeCredentialMatches =
        existing.activeCredential?.fingerprint === fingerprint;
      if (
        repeatedCredential
        || activeCredentialMatches
      ) {
        const activeCredential = existing.activeCredential;
        const activeCredentialIsCurrent =
          existing.status === TelegramBotConnectionStatus.ACTIVE
          && activeCredential?.status
            === TelegramBotCredentialStatus.ACTIVE
          && activeCredential.version === existing.credentialRevision
          && activeCredential.fingerprint === fingerprint
          && (
            !repeatedCredential
            || repeatedCredential.id === activeCredential.id
          );
        if (!activeCredentialIsCurrent) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection requires reconciliation.",
            409,
          );
        }
        const refreshed = await tx.telegramBotConnection.update({
          where: { id: existing.id },
          data: {
            username: verified.username,
            displayName: verified.displayName,
            ...(input.label === undefined ? {} : { label }),
            lastVerifiedAt: now,
            lastError: null,
          },
          select: ownerConnectionSelect,
        });
        return {
          connection: serializeOwnerConnection(refreshed),
          created: repeatedCredential?.version === 1,
          rotated: Boolean(
            repeatedCredential && repeatedCredential.version > 1,
          ),
        };
      }
      if (!existing.activeCredential) {
        if (
          existing.status
          !== TelegramBotConnectionStatus.PENDING_CREDENTIAL
        ) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection requires reconciliation.",
            409,
          );
        }
        const credentialVersion = existing.credentialRevision + 1;
        const encrypted = encryptTelegramBotToken(
          {
            token,
            telegramBotConnectionId: existing.id,
            botId: existing.botId,
            credentialVersion,
          },
          env,
        );
        const credential = await tx.telegramBotCredential.create({
          data: {
            telegramBotConnectionId: existing.id,
            version: credentialVersion,
            ciphertext: Uint8Array.from(encrypted.ciphertext),
            iv: Uint8Array.from(encrypted.iv),
            authTag: Uint8Array.from(encrypted.authTag),
            keyVersion: encrypted.keyVersion,
            algorithm: encrypted.algorithm,
            fingerprint: encrypted.fingerprint,
            status: TelegramBotCredentialStatus.ACTIVE,
            createdBy: actorId,
            requestId,
            idempotencyKey,
            activatedAt: now,
          },
          select: { id: true },
        });
        const activatedUpdate = await tx.telegramBotConnection.updateMany({
          where: {
            id: existing.id,
            activeCredentialId: null,
            credentialRevision: existing.credentialRevision,
            status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
          },
          data: {
            activeCredentialId: credential.id,
            credentialRevision: credentialVersion,
            username: verified.username,
            displayName: verified.displayName,
            ...(input.label === undefined ? {} : { label }),
            status: TelegramBotConnectionStatus.ACTIVE,
            healthStatus: ChannelHealthStatus.UNKNOWN,
            lastVerifiedAt: now,
            lastHealthCheckAt: null,
            lastError: null,
          },
        });
        if (activatedUpdate.count !== 1) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection changed while its credential was being activated.",
            409,
          );
        }
        const activated = await tx.telegramBotConnection.findUnique({
          where: { id: existing.id },
          select: ownerConnectionSelect,
        });
        if (!activated) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection not found.",
            404,
          );
        }
        return {
          connection: serializeOwnerConnection(activated),
          created: true,
          rotated: false,
        };
      }

      throw new TelegramBotConnectionError(
        "Existing Telegram Bot credentials must be rotated through the lifecycle operation.",
        409,
      );
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

/**
 * Rotates the credential for one existing owner-managed Bot. The verified
 * token must identify that exact Bot; this method never creates or switches a
 * connection. Disabled connections remain disabled after rotation.
 */
export async function rotateOwnerTelegramBotConnection(
  input: {
    ownerId: string;
    actorId: string;
    telegramBotConnectionId: string;
    token: string;
    label?: string | null;
    requestId: string;
    idempotencyKey: string;
  },
  dependencies: TelegramBotConnectionDependencies = {},
): Promise<OwnerTelegramBotRotationResult> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const actorId = requireText(input.actorId, "actorId");
  const telegramBotConnectionId = requireText(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const requestId = normalizeOperationToken(input.requestId, "requestId");
  const idempotencyKey = normalizeOperationToken(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const token = input.token.trim();
  const label = normalizeOptionalLabel(input.label);
  let tokenIdentity: ReturnType<typeof parseTelegramBotTokenIdentity>;
  try {
    tokenIdentity = parseTelegramBotTokenIdentity(token);
  } catch (error) {
    throw normalizeConnectionError(error);
  }
  const client = dependencies.client ?? prisma;
  requireLifecycleDatabase(client);
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? new Date();
  const verified = await verifyTelegramBotToken(
    token,
    dependencies.fetchImpl ?? fetch,
  );
  if (verified.botId !== tokenIdentity.botId) {
    throw new TelegramBotConnectionError(
      "Telegram Bot token does not match the verified Bot identity.",
      400,
    );
  }

  try {
    return await client.$transaction(async (tx) => {
      await lockOwnerTelegramBotConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const existing = await tx.telegramBotConnection.findFirst({
        where: {
          id: telegramBotConnectionId,
          ownerId,
          scope: TelegramBotConnectionScope.OWNER_MANAGED,
        },
        select: {
          ...ownerLifecycleConnectionSelect,
          credentials: {
            where: { idempotencyKey },
            orderBy: { version: "desc" },
            take: 1,
            select: {
              id: true,
              fingerprint: true,
            },
          },
        },
      });
      if (!existing) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection not found.",
          404,
        );
      }
      if (existing.botId !== verified.botId) {
        throw new TelegramBotConnectionError(
          "Telegram Bot token belongs to a different Bot.",
          409,
        );
      }
      const fingerprint = fingerprintTelegramBotToken(token, env);
      const repeatedCredential = existing.credentials[0] ?? null;
      if (
        repeatedCredential
        && repeatedCredential.fingerprint !== fingerprint
      ) {
        throw new TelegramBotConnectionError(
          "Idempotency key was already used for a different Telegram Bot credential.",
          409,
        );
      }
      const action = "TELEGRAM_BOT_TOKEN_ROTATED";
      const idempotencyRequestHash =
        buildOwnerTelegramBotIdempotencyRequestHash({
          action,
          payload: {
            tokenFingerprint: fingerprint,
            label: input.label === undefined
              ? { provided: false }
              : { provided: true, value: label },
          },
        });
      const repeatedAudit = await findOwnerTelegramBotLifecycleAudit(
        tx,
        {
          ownerId,
          telegramBotConnectionId,
          idempotencyKey,
        },
      );
      if (repeatedAudit) {
        assertOwnerTelegramBotIdempotencyReplay(repeatedAudit, {
          action,
          idempotencyRequestHash,
        });
        if (!repeatedCredential) {
          throw new TelegramBotConnectionError(
            "Telegram Bot credential operation requires reconciliation.",
            409,
          );
        }
        return {
          connection: serializeOwnerConnection(existing),
          changed: false,
          replayed: true,
          rotated: false,
        };
      }
      if (repeatedCredential) {
        throw new TelegramBotConnectionError(
          "Telegram Bot credential operation requires reconciliation.",
          409,
        );
      }
      if (
        existing.status === TelegramBotConnectionStatus.REVOKED
        || existing.revokedAt
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection has been revoked.",
          409,
        );
      }
      if (
        existing.status !== TelegramBotConnectionStatus.ACTIVE
        && existing.status !== TelegramBotConnectionStatus.DISABLED
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection is not ready for credential rotation.",
          409,
        );
      }
      const activeCredential = existing.activeCredential;
      if (
        !activeCredential
        || activeCredential.status !== TelegramBotCredentialStatus.ACTIVE
        || activeCredential.version !== existing.credentialRevision
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection requires reconciliation.",
          409,
        );
      }

      const auditContext = await resolveOwnerTelegramBotAuditContext(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const before = buildOwnerTelegramBotAuditSnapshot(existing);
      const credentialVersion = existing.credentialRevision + 1;
      const encrypted = encryptTelegramBotToken(
        {
          token,
          telegramBotConnectionId,
          botId: existing.botId,
          credentialVersion,
        },
        env,
      );
      const credential = await tx.telegramBotCredential.create({
        data: {
          telegramBotConnectionId,
          version: credentialVersion,
          ciphertext: Uint8Array.from(encrypted.ciphertext),
          iv: Uint8Array.from(encrypted.iv),
          authTag: Uint8Array.from(encrypted.authTag),
          keyVersion: encrypted.keyVersion,
          algorithm: encrypted.algorithm,
          fingerprint: encrypted.fingerprint,
          status: TelegramBotCredentialStatus.ACTIVE,
          createdBy: actorId,
          requestId,
          idempotencyKey,
          activatedAt: now,
        },
        select: { id: true },
      });
      const connectionUpdate = await tx.telegramBotConnection.updateMany({
        where: {
          id: telegramBotConnectionId,
          ownerId,
          scope: TelegramBotConnectionScope.OWNER_MANAGED,
          status: existing.status,
          revokedAt: null,
          activeCredentialId: activeCredential.id,
          credentialRevision: existing.credentialRevision,
        },
        data: {
          activeCredentialId: credential.id,
          credentialRevision: credentialVersion,
          username: verified.username,
          displayName: verified.displayName,
          ...(input.label === undefined ? {} : { label }),
          healthStatus: ChannelHealthStatus.UNKNOWN,
          lastVerifiedAt: now,
          lastHealthCheckAt: null,
          lastError: null,
        },
      });
      if (connectionUpdate.count !== 1) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection changed while its credential was being rotated.",
          409,
        );
      }
      const credentialUpdate = await tx.telegramBotCredential.updateMany({
        where: {
          id: activeCredential.id,
          telegramBotConnectionId,
          version: activeCredential.version,
          status: TelegramBotCredentialStatus.ACTIVE,
        },
        data: {
          ciphertext: null,
          iv: null,
          authTag: null,
          status: TelegramBotCredentialStatus.RETIRED,
          retiredAt: now,
        },
      });
      if (credentialUpdate.count !== 1) {
        throw new TelegramBotConnectionError(
          "Telegram Bot credential changed while it was being retired.",
          409,
        );
      }
      const updated = await requireOwnerLifecycleConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      await createOwnerTelegramBotLifecycleAudit(tx, {
        ...auditContext,
        actorId,
        requestId,
        idempotencyKey,
        idempotencyRequestHash,
        telegramBotConnectionId,
        action,
        before,
        after: buildOwnerTelegramBotAuditSnapshot(updated),
        changed: true,
      });
      return {
        connection: serializeOwnerConnection(updated),
        changed: true,
        replayed: false,
        rotated: true,
      };
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

/**
 * Disables or resumes one owner-managed Bot without discarding its encrypted
 * credential. Resuming fails closed unless the active credential and revision
 * are coherent.
 */
export async function setOwnerTelegramBotConnectionStatus(
  input: {
    ownerId: string;
    actorId: string;
    telegramBotConnectionId: string;
    status: "ACTIVE" | "DISABLED";
    requestId: string;
    idempotencyKey: string;
  },
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client" | "now"
  > = {},
): Promise<OwnerTelegramBotLifecycleResult> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const actorId = requireText(input.actorId, "actorId");
  const telegramBotConnectionId = requireText(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const requestId = normalizeOperationToken(input.requestId, "requestId");
  const idempotencyKey = normalizeOperationToken(
    input.idempotencyKey,
    "idempotencyKey",
  );
  if (
    input.status !== TelegramBotConnectionStatus.ACTIVE
    && input.status !== TelegramBotConnectionStatus.DISABLED
  ) {
    throw new TelegramBotConnectionError(
      "Telegram Bot connection status is invalid.",
      400,
    );
  }
  const targetStatus = input.status;
  const client = dependencies.client ?? prisma;
  requireLifecycleDatabase(client);

  try {
    return await client.$transaction(async (tx) => {
      await lockOwnerTelegramBotConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const existing = await requireOwnerLifecycleConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const action =
        targetStatus === TelegramBotConnectionStatus.ACTIVE
          ? "TELEGRAM_BOT_CONNECTION_RESUMED"
          : "TELEGRAM_BOT_CONNECTION_DISABLED";
      const idempotencyRequestHash =
        buildOwnerTelegramBotIdempotencyRequestHash({
          action,
          payload: { status: targetStatus },
        });
      const repeatedAudit = await findOwnerTelegramBotLifecycleAudit(
        tx,
        {
          ownerId,
          telegramBotConnectionId,
          idempotencyKey,
        },
      );
      if (repeatedAudit) {
        assertOwnerTelegramBotIdempotencyReplay(repeatedAudit, {
          action,
          idempotencyRequestHash,
        });
        return {
          connection: serializeOwnerConnection(existing),
          changed: false,
          replayed: true,
        };
      }
      if (
        existing.status === TelegramBotConnectionStatus.REVOKED
        || existing.revokedAt
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection has been revoked.",
          409,
        );
      }
      if (
        existing.status !== TelegramBotConnectionStatus.ACTIVE
        && existing.status !== TelegramBotConnectionStatus.DISABLED
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection is not ready for this status change.",
          409,
        );
      }
      if (targetStatus === TelegramBotConnectionStatus.ACTIVE) {
        const credential = existing.activeCredential;
        if (
          !credential
          || credential.status !== TelegramBotCredentialStatus.ACTIVE
          || credential.version !== existing.credentialRevision
        ) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection requires reconciliation.",
            409,
          );
        }
      }

      const auditContext = await resolveOwnerTelegramBotAuditContext(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const before = buildOwnerTelegramBotAuditSnapshot(existing);
      const changed = existing.status !== targetStatus;
      let updated = existing;
      if (changed) {
        const connectionUpdate =
          await tx.telegramBotConnection.updateMany({
            where: {
              id: telegramBotConnectionId,
              ownerId,
              scope: TelegramBotConnectionScope.OWNER_MANAGED,
              status: existing.status,
              revokedAt: null,
              activeCredentialId: existing.activeCredentialId,
              credentialRevision: existing.credentialRevision,
            },
            data: {
              status: targetStatus,
              healthStatus: ChannelHealthStatus.UNKNOWN,
              lastHealthCheckAt: null,
              lastError: null,
            },
          });
        if (connectionUpdate.count !== 1) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection changed while its status was being updated.",
            409,
          );
        }
        updated = await requireOwnerLifecycleConnection(
          tx,
          ownerId,
          telegramBotConnectionId,
        );
      }
      await createOwnerTelegramBotLifecycleAudit(tx, {
        ...auditContext,
        actorId,
        requestId,
        idempotencyKey,
        idempotencyRequestHash,
        telegramBotConnectionId,
        action,
        before,
        after: buildOwnerTelegramBotAuditSnapshot(updated),
        changed,
      });
      return {
        connection: serializeOwnerConnection(updated),
        changed,
        replayed: false,
      };
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

/**
 * Irreversibly revokes a Bot, cryptographically erases all credential
 * versions, and disconnects/clears every representative binding that
 * referenced it.
 */
export async function revokeOwnerTelegramBotConnection(
  input: {
    ownerId: string;
    actorId: string;
    telegramBotConnectionId: string;
    requestId: string;
    idempotencyKey: string;
  },
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client" | "now"
  > = {},
): Promise<OwnerTelegramBotLifecycleResult> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const actorId = requireText(input.actorId, "actorId");
  const telegramBotConnectionId = requireText(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const requestId = normalizeOperationToken(input.requestId, "requestId");
  const idempotencyKey = normalizeOperationToken(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const client = dependencies.client ?? prisma;
  requireLifecycleDatabase(client);
  const now = dependencies.now ?? new Date();

  try {
    return await client.$transaction(async (tx) => {
      await lockOwnerTelegramBotConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const existing = await requireOwnerLifecycleConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const action = "TELEGRAM_BOT_CONNECTION_REVOKED";
      const idempotencyRequestHash =
        buildOwnerTelegramBotIdempotencyRequestHash({
          action,
          payload: {},
        });
      const repeatedAudit = await findOwnerTelegramBotLifecycleAudit(
        tx,
        {
          ownerId,
          telegramBotConnectionId,
          idempotencyKey,
        },
      );
      if (repeatedAudit) {
        assertOwnerTelegramBotIdempotencyReplay(repeatedAudit, {
          action,
          idempotencyRequestHash,
        });
        return {
          connection: serializeOwnerConnection(existing),
          changed: false,
          replayed: true,
        };
      }
      if (
        existing.status === TelegramBotConnectionStatus.REVOKED
        || existing.revokedAt
      ) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection has been revoked.",
          409,
        );
      }
      const auditContext = await resolveOwnerTelegramBotAuditContext(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      const before = buildOwnerTelegramBotAuditSnapshot(existing);
      const connectionUpdate =
        await tx.telegramBotConnection.updateMany({
          where: {
            id: telegramBotConnectionId,
            ownerId,
            scope: TelegramBotConnectionScope.OWNER_MANAGED,
            status: existing.status,
            revokedAt: null,
            activeCredentialId: existing.activeCredentialId,
            credentialRevision: existing.credentialRevision,
          },
          data: {
            status: TelegramBotConnectionStatus.REVOKED,
            activeCredentialId: null,
            healthStatus: ChannelHealthStatus.UNKNOWN,
            lastHealthCheckAt: null,
            lastError: null,
            revokedAt: now,
          },
        });
      if (connectionUpdate.count !== 1) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection changed while it was being revoked.",
          409,
        );
      }
      await tx.representativeChannelBinding.updateMany({
        where: { telegramBotConnectionId },
        data: buildUnassignedTelegramBindingUpdate(),
      });
      await tx.telegramBotCredential.updateMany({
        where: { telegramBotConnectionId },
        data: {
          ciphertext: null,
          iv: null,
          authTag: null,
          status: TelegramBotCredentialStatus.REVOKED,
          revokedAt: now,
        },
      });
      const updated = await requireOwnerLifecycleConnection(
        tx,
        ownerId,
        telegramBotConnectionId,
      );
      await createOwnerTelegramBotLifecycleAudit(tx, {
        ...auditContext,
        actorId,
        requestId,
        idempotencyKey,
        idempotencyRequestHash,
        telegramBotConnectionId,
        action,
        before,
        after: buildOwnerTelegramBotAuditSnapshot(updated),
        changed: true,
      });
      return {
        connection: serializeOwnerConnection(updated),
        changed: true,
        replayed: false,
      };
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

/**
 * Detaches only the requested representative binding. The historical binding
 * row is retained in a disconnected state.
 */
export async function unassignOwnerTelegramBotConnection(
  input: {
    ownerId: string;
    actorId: string;
    bindingId: string;
    telegramBotConnectionId: string;
    requestId: string;
    idempotencyKey: string;
  },
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client"
  > = {},
): Promise<OwnerTelegramBotUnassignmentResult> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const actorId = requireText(input.actorId, "actorId");
  const bindingId = requireText(input.bindingId, "bindingId");
  const expectedTelegramBotConnectionId = requireText(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  const requestId = normalizeOperationToken(input.requestId, "requestId");
  const idempotencyKey = normalizeOperationToken(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const client = dependencies.client ?? prisma;
  requireLifecycleDatabase(client);

  try {
    return await client.$transaction(async (tx) => {
      const initiallySelected =
        await tx.representativeChannelBinding.findFirst({
          where: {
            id: bindingId,
            kind: RepresentativeChannelKind.TELEGRAM,
            representative: { ownerId },
          },
          select: ownerTelegramBindingSelect,
        });
      if (!initiallySelected) {
        throw new TelegramBotConnectionError(
          "Telegram channel binding not found.",
          404,
        );
      }
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${"telegram-bot-channel:" + initiallySelected.representativeId})
        )
      `;
      if (initiallySelected.telegramBotConnectionId) {
        const lockTarget = await tx.telegramBotConnection.findUnique({
          where: { id: initiallySelected.telegramBotConnectionId },
          select: { botId: true },
        });
        if (!lockTarget) {
          throw new TelegramBotConnectionError(
            "Telegram Bot connection not found.",
            404,
          );
        }
        await lockTelegramBotConnection(
          tx,
          lockTarget.botId,
        );
      }
      const existing = await tx.representativeChannelBinding.findFirst({
        where: {
          id: bindingId,
          kind: RepresentativeChannelKind.TELEGRAM,
          representative: { ownerId },
        },
        select: ownerTelegramBindingSelect,
      });
      if (!existing) {
        throw new TelegramBotConnectionError(
          "Telegram channel binding not found.",
          404,
        );
      }
      const action = "REPRESENTATIVE_TELEGRAM_BOT_UNASSIGNED";
      const idempotencyRequestHash =
        buildOwnerTelegramBotIdempotencyRequestHash({
          action,
          payload: {
            telegramBotConnectionId:
              expectedTelegramBotConnectionId,
          },
        });
      const repeatedAudit = await tx.eventAudit.findFirst({
        where: {
          representativeId: existing.representativeId,
          type: EventType.CHANNEL_CONFIGURATION_CHANGED,
          AND: [
            {
              payload: {
                path: ["auditScope"],
                equals: ownerTelegramBotAuditScope,
              },
            },
            {
              payload: {
                path: ["bindingId"],
                equals: bindingId,
              },
            },
            {
              payload: {
                path: ["idempotencyKey"],
                equals: idempotencyKey,
              },
            },
          ],
        },
        select: { payload: true },
      });
      if (repeatedAudit) {
        assertOwnerTelegramBotIdempotencyReplay(repeatedAudit, {
          action,
          idempotencyRequestHash,
        });
        return {
          binding: serializeOwnerTelegramBinding(existing),
          changed: false,
          replayed: true,
        };
      }
      if (
        existing.telegramBotConnectionId
        !== expectedTelegramBotConnectionId
      ) {
        throw new TelegramBotConnectionError(
          "Telegram channel binding changed since it was loaded.",
          409,
        );
      }

      const changed =
        existing.telegramBotConnectionId !== null
        || existing.connectionId !== null
        || existing.desiredState !== ChannelDesiredState.DISCONNECTED
        || existing.status !== "DISCONNECTED";
      let updated = existing;
      if (changed) {
        const bindingUpdate =
          await tx.representativeChannelBinding.updateMany({
            where: {
              id: bindingId,
              representativeId: existing.representativeId,
              telegramBotConnectionId:
                expectedTelegramBotConnectionId,
              connectionId: existing.connectionId,
              desiredState: existing.desiredState,
            },
            data: buildUnassignedTelegramBindingUpdate(),
          });
        if (bindingUpdate.count !== 1) {
          throw new TelegramBotConnectionError(
            "Telegram channel binding changed while it was being unassigned.",
            409,
          );
        }
        const selected =
          await tx.representativeChannelBinding.findUnique({
            where: { id: bindingId },
            select: ownerTelegramBindingSelect,
          });
        if (!selected) {
          throw new TelegramBotConnectionError(
            "Telegram channel binding not found.",
            404,
          );
        }
        updated = selected;
      }
      await tx.eventAudit.create({
        data: {
          representativeId: existing.representativeId,
          type: EventType.CHANNEL_CONFIGURATION_CHANGED,
          payload: {
            auditScope: ownerTelegramBotAuditScope,
            kind: "representative_telegram_bot_unassigned",
            action,
            actorId,
            requestId,
            idempotencyKey,
            idempotencyRequestHash,
            bindingId,
            connectionId: existing.telegramBotConnectionId,
            affectedRepresentativeIds: [existing.representativeId],
            referenceCount:
              existing.telegramBotConnectionId === null ? 0 : 1,
            before: serializeOwnerTelegramBinding(existing),
            after: serializeOwnerTelegramBinding(updated),
            changed,
          },
        },
      });
      return {
        binding: serializeOwnerTelegramBinding(updated),
        changed,
        replayed: false,
      };
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

export async function listOwnerTelegramBotConnections(
  input: { ownerId: string },
  dependencies: Pick<TelegramBotConnectionDependencies, "client"> = {},
): Promise<OwnerTelegramBotConnection[]> {
  const ownerId = requireText(input.ownerId, "ownerId");
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return [];
  const connections = await client.telegramBotConnection.findMany({
    where: {
      ownerId,
      scope: TelegramBotConnectionScope.OWNER_MANAGED,
      revokedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: ownerConnectionSelect,
  });
  return connections.map(serializeOwnerConnection);
}

export async function bootstrapLegacyTelegramBotConnectionFromEnv(
  dependencies: TelegramBotConnectionDependencies = {},
): Promise<OwnerTelegramBotConnection | null> {
  const env = dependencies.env ?? process.env;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  let botId: string;
  try {
    botId = parseTelegramBotTokenIdentity(token).botId;
  } catch (error) {
    throw normalizeConnectionError(error);
  }
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return null;
  const pending = await client.telegramBotConnection.findFirst({
    where: {
      botId,
      scope: {
        in: [
          TelegramBotConnectionScope.OWNER_MANAGED,
          TelegramBotConnectionScope.PLATFORM_MANAGED,
        ],
      },
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      activeCredentialId: null,
      revokedAt: null,
    },
    select: {
      id: true,
      botId: true,
    },
  });
  if (!pending) return null;
  const verified = await verifyTelegramBotToken(
    token,
    dependencies.fetchImpl ?? fetch,
  );
  if (verified.botId !== pending.botId) {
    throw new TelegramBotConnectionError(
      "Telegram Bot token does not match the pending connection.",
      400,
    );
  }
  const now = dependencies.now ?? new Date();
  const idempotencyKey = `legacy-telegram-bootstrap:${botId}`;

  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${"telegram-bot-connection:" + botId})
        )
      `;
      const current = await tx.telegramBotConnection.findFirst({
        where: {
          id: pending.id,
          botId,
          scope: {
            in: [
              TelegramBotConnectionScope.OWNER_MANAGED,
              TelegramBotConnectionScope.PLATFORM_MANAGED,
            ],
          },
          status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
          activeCredentialId: null,
          revokedAt: null,
        },
        select: {
          id: true,
          botId: true,
          credentialRevision: true,
        },
      });
      if (!current) return null;
      const credentialVersion = current.credentialRevision + 1;
      const encrypted = encryptTelegramBotToken(
        {
          token,
          telegramBotConnectionId: current.id,
          botId: current.botId,
          credentialVersion,
        },
        env,
      );
      const credential = await tx.telegramBotCredential.create({
        data: {
          telegramBotConnectionId: current.id,
          version: credentialVersion,
          ciphertext: Uint8Array.from(encrypted.ciphertext),
          iv: Uint8Array.from(encrypted.iv),
          authTag: Uint8Array.from(encrypted.authTag),
          keyVersion: encrypted.keyVersion,
          algorithm: encrypted.algorithm,
          fingerprint: encrypted.fingerprint,
          status: TelegramBotCredentialStatus.ACTIVE,
          createdBy: "system:legacy-telegram-bootstrap",
          requestId: idempotencyKey,
          idempotencyKey,
          activatedAt: now,
        },
        select: { id: true },
      });
      const activated = await tx.telegramBotConnection.updateMany({
        where: {
          id: current.id,
          botId,
          credentialRevision: current.credentialRevision,
          activeCredentialId: null,
          status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
        },
        data: {
          activeCredentialId: credential.id,
          credentialRevision: credentialVersion,
          username: verified.username,
          displayName: verified.displayName,
          status: TelegramBotConnectionStatus.ACTIVE,
          healthStatus: ChannelHealthStatus.UNKNOWN,
          lastVerifiedAt: now,
          lastHealthCheckAt: null,
          lastError: null,
        },
      });
      if (activated.count !== 1) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection changed while its legacy credential was being activated.",
          409,
        );
      }
      const connection = await tx.telegramBotConnection.findUnique({
        where: { id: current.id },
        select: ownerConnectionSelect,
      });
      if (!connection) {
        throw new TelegramBotConnectionError(
          "Telegram Bot connection not found.",
          404,
        );
      }
      return serializeOwnerConnection(connection);
    });
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

export async function resolveTelegramBotRuntimeCredential(
  input: { connectionId: string },
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client" | "env"
  > = {},
): Promise<TelegramBotRuntimeCredential | null> {
  const connectionId = requireText(input.connectionId, "connectionId");
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return null;
  const connection = await client.telegramBotConnection.findFirst({
    where: {
      OR: [
        { id: connectionId },
        { botId: connectionId },
      ],
      status: TelegramBotConnectionStatus.ACTIVE,
      revokedAt: null,
    },
    select: runtimeConnectionSelect,
  });
  if (!connection?.activeCredential) return null;
  return decryptRuntimeConnection(
    connection,
    dependencies.env ?? process.env,
  );
}

export async function listActiveTelegramBotRuntimeConfigs(
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client" | "env"
  > = {},
): Promise<TelegramBotRuntimeCredential[]> {
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return [];
  const connections = await client.telegramBotConnection.findMany({
    where: {
      status: TelegramBotConnectionStatus.ACTIVE,
      revokedAt: null,
      activeCredentialId: { not: null },
      representativeBindings: {
        some: {
          kind: RepresentativeChannelKind.TELEGRAM,
          desiredState: ChannelDesiredState.ACTIVE,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: runtimeConnectionSelect,
  });
  const configs: TelegramBotRuntimeCredential[] = [];
  for (const connection of connections) {
    if (!connection.activeCredential) continue;
    try {
      configs.push(
        decryptRuntimeConnection(
          connection,
          dependencies.env ?? process.env,
        ),
      );
    } catch {
      // One corrupt or stale credential must fail closed for that Bot without
      // preventing the supervisor from reconciling every other connection.
      await markTelegramBotRuntimeHealth(
        {
          telegramBotConnectionId: connection.id,
          healthStatus: ChannelHealthStatus.UNHEALTHY,
          lastError: "Telegram Bot credential is unavailable.",
        },
        { client },
      ).catch(() => undefined);
    }
  }
  return configs;
}

/**
 * Safe supervisor discovery. This deliberately does not select or decrypt
 * credential material; only the process that owns the polling lease resolves
 * the token for one connection.
 */
export async function listActiveTelegramBotRuntimeDescriptors(
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client"
  > = {},
): Promise<TelegramBotRuntimeDescriptor[]> {
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return [];
  const connections = await client.telegramBotConnection.findMany({
    where: {
      status: TelegramBotConnectionStatus.ACTIVE,
      revokedAt: null,
      activeCredentialId: { not: null },
      representativeBindings: {
        some: {
          kind: RepresentativeChannelKind.TELEGRAM,
          desiredState: ChannelDesiredState.ACTIVE,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      botId: true,
      username: true,
      displayName: true,
      credentialRevision: true,
    },
  });
  return connections.map((connection) => ({
    connectionId: connection.id,
    botId: connection.botId,
    username: connection.username,
    displayName: connection.displayName,
    credentialRevision: connection.credentialRevision,
  }));
}

export async function hasPersistedTelegramBotConnections(
  dependencies: Pick<
    TelegramBotConnectionDependencies,
    "client"
  > = {},
): Promise<boolean> {
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) return false;
  return (await client.telegramBotConnection.count()) > 0;
}

export async function markTelegramBotRuntimeHealth(
  input: {
    telegramBotConnectionId: string;
    healthStatus: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
    lastError?: string | null;
    checkedAt?: Date;
  },
  dependencies: Pick<TelegramBotConnectionDependencies, "client"> = {},
) {
  const telegramBotConnectionId = requireText(
    input.telegramBotConnectionId,
    "telegramBotConnectionId",
  );
  if (
    input.healthStatus !== ChannelHealthStatus.HEALTHY
    && input.healthStatus !== ChannelHealthStatus.DEGRADED
    && input.healthStatus !== ChannelHealthStatus.UNHEALTHY
  ) {
    throw new TelegramBotConnectionError(
      "Telegram Bot health status is invalid.",
      400,
    );
  }
  const checkedAt = input.checkedAt ?? new Date();
  const lastError = sanitizeRuntimeError(input.lastError);
  const client = dependencies.client ?? prisma;
  if (client === prisma && !process.env.DATABASE_URL?.trim()) {
    throw new TelegramBotConnectionError(
      "Telegram Bot health updates require a database connection.",
      503,
    );
  }
  return client.$transaction(async (tx) => {
    const updated = await tx.telegramBotConnection.updateMany({
      where: {
        id: telegramBotConnectionId,
        revokedAt: null,
      },
      data: {
        healthStatus: input.healthStatus,
        lastHealthCheckAt: checkedAt,
        lastError,
      },
    });
    if (updated.count !== 1) {
      throw new TelegramBotConnectionError(
        "Telegram Bot connection not found.",
        404,
      );
    }
    await tx.representativeChannelBinding.updateMany({
      where: { telegramBotConnectionId },
      data: {
        healthStatus: input.healthStatus,
        lastHealthCheckAt: checkedAt,
        lastError,
      },
    });
    return {
      telegramBotConnectionId,
      healthStatus: input.healthStatus,
      lastHealthCheckAt: checkedAt.toISOString(),
      lastError,
    };
  });
}

export async function verifyTelegramBotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedTelegramBot> {
  const normalizedToken = token.trim();
  const tokenIdentity = parseTelegramBotTokenIdentity(normalizedToken);
  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${normalizedToken}/getMe`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(getMeTimeoutMs),
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      result?: {
        id?: unknown;
        is_bot?: unknown;
        first_name?: unknown;
        last_name?: unknown;
        username?: unknown;
      };
    } | null;
    const id = payload?.result?.id;
    const botId =
      typeof id === "number" && Number.isSafeInteger(id) && id > 0
        ? String(id)
        : typeof id === "string" && /^[1-9]\d{5,19}$/.test(id)
          ? id
          : null;
    if (
      !response.ok
      || payload?.ok !== true
      || payload.result?.is_bot !== true
      || !botId
      || botId !== tokenIdentity.botId
    ) {
      throw new Error("telegram verification rejected");
    }
    const username = normalizeTelegramUsername(payload.result.username);
    const firstName = normalizeTelegramDisplayPart(
      payload.result.first_name,
    );
    const lastName = normalizeTelegramDisplayPart(payload.result.last_name);
    return {
      botId,
      username,
      displayName: [firstName, lastName].filter(Boolean).join(" ") || null,
    };
  } catch {
    throw new TelegramBotConnectionError(
      "Telegram Bot token could not be verified.",
      400,
    );
  }
}

const runtimeConnectionSelect = {
  id: true,
  botId: true,
  username: true,
  displayName: true,
  credentialRevision: true,
  activeCredential: {
    select: {
      version: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      keyVersion: true,
      algorithm: true,
      fingerprint: true,
      status: true,
    },
  },
} as const;

function decryptRuntimeConnection(
  connection: {
    id: string;
    botId: string;
    username: string | null;
    displayName: string | null;
    credentialRevision: number;
    activeCredential: {
      version: number;
      ciphertext: Uint8Array | null;
      iv: Uint8Array | null;
      authTag: Uint8Array | null;
      keyVersion: string;
      algorithm: string;
      fingerprint: string;
      status: TelegramBotCredentialStatus;
    } | null;
  },
  env: Readonly<Record<string, string | undefined>>,
): TelegramBotRuntimeCredential {
  const credential = connection.activeCredential;
  if (
    !credential
    || credential.status !== TelegramBotCredentialStatus.ACTIVE
    || credential.version !== connection.credentialRevision
  ) {
    throw new TelegramBotConnectionError(
      "Telegram Bot credential requires reconciliation.",
      503,
    );
  }
  try {
    const token = decryptTelegramBotToken(
      {
        credential,
        telegramBotConnectionId: connection.id,
        botId: connection.botId,
        credentialVersion: credential.version,
      },
      env,
    );
    return {
      connectionId: connection.id,
      botId: connection.botId,
      username: connection.username,
      displayName: connection.displayName,
      token,
      credentialRevision: connection.credentialRevision,
    };
  } catch (error) {
    throw normalizeConnectionError(error);
  }
}

function serializeOwnerConnection(connection: {
  id: string;
  botId: string;
  username: string | null;
  displayName: string | null;
  label: string | null;
  status: TelegramBotConnectionStatus;
  healthStatus: ChannelHealthStatus;
  lastVerifiedAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  credentialRevision: number;
  representativeBindings: Array<{ desiredState: ChannelDesiredState }>;
}): OwnerTelegramBotConnection {
  return {
    id: connection.id,
    botId: connection.botId,
    username: connection.username,
    displayName: connection.displayName,
    label: connection.label,
    status: connection.status,
    healthStatus: connection.healthStatus,
    verificationStatus: connection.lastVerifiedAt ? "VERIFIED" : "PENDING",
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    lastHealthCheckAt:
      connection.lastHealthCheckAt?.toISOString() ?? null,
    lastError: sanitizeRuntimeError(connection.lastError),
    credentialRevision: connection.credentialRevision,
    referenceCount: connection.representativeBindings.length,
    activeReferenceCount: connection.representativeBindings.filter(
      (binding) => binding.desiredState === ChannelDesiredState.ACTIVE,
    ).length,
  };
}

type OwnerLifecycleConnectionRecord = {
  id: string;
  ownerId: string | null;
  scope: TelegramBotConnectionScope;
  botId: string;
  username: string | null;
  displayName: string | null;
  label: string | null;
  status: TelegramBotConnectionStatus;
  healthStatus: ChannelHealthStatus;
  activeCredentialId: string | null;
  credentialRevision: number;
  lastVerifiedAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  revokedAt: Date | null;
  representativeBindings: Array<{
    desiredState: ChannelDesiredState;
  }>;
  activeCredential: {
    id: string;
    version: number;
    fingerprint: string;
    status: TelegramBotCredentialStatus;
  } | null;
};

type OwnerTelegramBotAuditSnapshot = {
  status: TelegramBotConnectionStatus;
  label: string | null;
  credentialRevision: number;
  hasActiveCredential: boolean;
  referenceCount: number;
  activeReferenceCount: number;
};

async function lockTelegramBotConnection(
  tx: Prisma.TransactionClient,
  botId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${"telegram-bot-connection:" + botId})
    )
  `;
}

async function lockOwnerTelegramBotConnection(
  tx: Prisma.TransactionClient,
  ownerId: string,
  telegramBotConnectionId: string,
) {
  const lockTarget = await tx.telegramBotConnection.findFirst({
    where: {
      id: telegramBotConnectionId,
      ownerId,
      scope: TelegramBotConnectionScope.OWNER_MANAGED,
    },
    select: { botId: true },
  });
  if (!lockTarget) {
    throw new TelegramBotConnectionError(
      "Telegram Bot connection not found.",
      404,
    );
  }
  await lockTelegramBotConnection(tx, lockTarget.botId);
}

async function requireOwnerLifecycleConnection(
  tx: Prisma.TransactionClient,
  ownerId: string,
  telegramBotConnectionId: string,
): Promise<OwnerLifecycleConnectionRecord> {
  const connection = await tx.telegramBotConnection.findFirst({
    where: {
      id: telegramBotConnectionId,
      ownerId,
      scope: TelegramBotConnectionScope.OWNER_MANAGED,
    },
    select: ownerLifecycleConnectionSelect,
  });
  if (!connection) {
    throw new TelegramBotConnectionError(
      "Telegram Bot connection not found.",
      404,
    );
  }
  return connection;
}

async function findOwnerTelegramBotLifecycleAudit(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    telegramBotConnectionId: string;
    idempotencyKey: string;
  },
) {
  return tx.eventAudit.findFirst({
    where: {
      representative: { ownerId: input.ownerId },
      type: EventType.CHANNEL_CONFIGURATION_CHANGED,
      AND: [
        {
          payload: {
            path: ["auditScope"],
            equals: ownerTelegramBotAuditScope,
          },
        },
        {
          payload: {
            path: ["connectionId"],
            equals: input.telegramBotConnectionId,
          },
        },
        {
          payload: {
            path: ["idempotencyKey"],
            equals: input.idempotencyKey,
          },
        },
      ],
    },
    select: { payload: true },
  });
}

async function resolveOwnerTelegramBotAuditContext(
  tx: Prisma.TransactionClient,
  ownerId: string,
  telegramBotConnectionId: string,
) {
  const bindings = await tx.representativeChannelBinding.findMany({
    where: {
      telegramBotConnectionId,
      representative: { ownerId },
    },
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      representativeId: true,
    },
  });
  const affectedRepresentativeIds = [
    ...new Set(bindings.map((binding) => binding.representativeId)),
  ];
  let auditAnchorRepresentativeId =
    affectedRepresentativeIds[0] ?? null;
  if (!auditAnchorRepresentativeId) {
    const fallback = await tx.representative.findFirst({
      where: { ownerId },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
      select: { id: true },
    });
    auditAnchorRepresentativeId = fallback?.id ?? null;
  }
  if (!auditAnchorRepresentativeId) {
    throw new TelegramBotConnectionError(
      "Telegram Bot lifecycle changes require an owner representative for auditing.",
      409,
    );
  }
  return {
    auditAnchorRepresentativeId,
    affectedRepresentativeIds,
    referenceCount: bindings.length,
  };
}

async function createOwnerTelegramBotLifecycleAudit(
  tx: Prisma.TransactionClient,
  input: {
    auditAnchorRepresentativeId: string;
    affectedRepresentativeIds: string[];
    referenceCount: number;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
    idempotencyRequestHash: string;
    telegramBotConnectionId: string;
    action: string;
    before: OwnerTelegramBotAuditSnapshot;
    after: OwnerTelegramBotAuditSnapshot;
    changed: boolean;
  },
) {
  await tx.eventAudit.create({
    data: {
      representativeId: input.auditAnchorRepresentativeId,
      type: EventType.CHANNEL_CONFIGURATION_CHANGED,
      payload: {
        auditScope: ownerTelegramBotAuditScope,
        kind: input.action.toLowerCase(),
        action: input.action,
        actorId: input.actorId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        idempotencyRequestHash: input.idempotencyRequestHash,
        connectionId: input.telegramBotConnectionId,
        affectedRepresentativeIds: input.affectedRepresentativeIds,
        referenceCount: input.referenceCount,
        before: input.before,
        after: input.after,
        changed: input.changed,
      },
    },
  });
}

function buildOwnerTelegramBotIdempotencyRequestHash(input: {
  action: string;
  payload: Record<string, unknown>;
}) {
  return createHash("sha256")
    .update("delegate:owner-telegram-bot-idempotency:v1\0", "utf8")
    .update(JSON.stringify([input.action, input.payload]), "utf8")
    .digest("hex");
}

function assertOwnerTelegramBotIdempotencyReplay(
  audit: { payload: unknown },
  expected: {
    action: string;
    idempotencyRequestHash: string;
  },
) {
  const payload = isJsonObject(audit.payload) ? audit.payload : null;
  if (
    payload?.action !== expected.action
    || payload.idempotencyRequestHash
      !== expected.idempotencyRequestHash
  ) {
    throw new TelegramBotConnectionError(
      ownerTelegramBotIdempotencyConflictMessage,
      409,
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function buildOwnerTelegramBotAuditSnapshot(
  connection: {
    status: TelegramBotConnectionStatus;
    label: string | null;
    credentialRevision: number;
    activeCredentialId: string | null;
    representativeBindings: Array<{
      desiredState: ChannelDesiredState;
    }>;
  },
): OwnerTelegramBotAuditSnapshot {
  return {
    status: connection.status,
    label: connection.label,
    credentialRevision: connection.credentialRevision,
    hasActiveCredential: connection.activeCredentialId !== null,
    referenceCount: connection.representativeBindings.length,
    activeReferenceCount: connection.representativeBindings.filter(
      (binding) => binding.desiredState === ChannelDesiredState.ACTIVE,
    ).length,
  };
}

function buildUnassignedTelegramBindingUpdate() {
  return {
    telegramBotConnectionId: null,
    connectionId: null,
    desiredState: ChannelDesiredState.DISCONNECTED,
    healthStatus: ChannelHealthStatus.UNKNOWN,
    externalUserId: null,
    status: "DISCONNECTED",
    configuration: {},
    lastHealthCheckAt: null,
    lastError: null,
  } as const;
}

function serializeOwnerTelegramBinding(binding: {
  id: string;
  representativeId: string;
  telegramBotConnectionId: string | null;
  connectionId: string | null;
  desiredState: ChannelDesiredState;
  status: string;
}): OwnerTelegramBotUnassignmentResult["binding"] {
  return {
    id: binding.id,
    representativeId: binding.representativeId,
    telegramBotConnectionId: binding.telegramBotConnectionId,
    connectionId: binding.connectionId,
    desiredState: binding.desiredState,
    status: binding.status,
  };
}

function requireLifecycleDatabase(client: typeof prisma) {
  if (client === prisma && !process.env.DATABASE_URL?.trim()) {
    throw new TelegramBotConnectionError(
      "Telegram Bot lifecycle changes require a database connection.",
      503,
    );
  }
}

function normalizeConnectionError(error: unknown): TelegramBotConnectionError {
  if (error instanceof TelegramBotConnectionError) return error;
  if (error instanceof TelegramBotCredentialError) {
    return new TelegramBotConnectionError(
      error.code === "INVALID_TOKEN"
        ? error.message
        : "Telegram Bot credential is unavailable.",
      error.code === "INVALID_TOKEN" ? 400 : 503,
    );
  }
  return new TelegramBotConnectionError(
    "Telegram Bot connection could not be updated.",
    503,
  );
}

function normalizeOperationToken(value: string, label: string) {
  const normalized = value.trim();
  if (!safeOperationToken.test(normalized)) {
    throw new TelegramBotConnectionError(`${label} is invalid.`, 400);
  }
  return normalized;
}

function requireText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191 || normalized.includes("\0")) {
    throw new TelegramBotConnectionError(`${label} is required.`, 400);
  }
  return normalized;
}

function normalizeOptionalLabel(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 100 || normalized.includes("\0")) {
    throw new TelegramBotConnectionError(
      "Telegram Bot label must be at most 100 characters.",
      400,
    );
  }
  return normalized;
}

function normalizeTelegramUsername(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^@/, "");
  return telegramUsernamePattern.test(normalized) ? normalized : null;
}

function normalizeTelegramDisplayPart(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= 64 ? normalized : null;
}

function sanitizeRuntimeError(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .replace(/\b[1-9]\d{5,19}:[A-Za-z0-9_-]{20,200}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted-url]")
    .replace(
      /\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 240);
}
