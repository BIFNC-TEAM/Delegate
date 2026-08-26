import {
  AuthIdentityProvider,
  AuthIdentityStatus,
  AccountStatus,
  Prisma,
} from "@prisma/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { readLogtoIssuer } from "./auth-session";
import { prisma } from "./prisma";

export const LOGTO_WEBHOOK_SIGNATURE_HEADER =
  "logto-signature-sha-256";
export const MAX_LOGTO_WEBHOOK_BODY_BYTES = 64 * 1024;

type LogtoLifecycleEvent =
  | {
      event: "Logto.Test";
      hookId: string;
      providerSubject: "fake-id";
      providerCreatedAt: Date;
    }
  | {
      event: "User.SuspensionStatus.Updated";
      hookId: string;
      providerSubject: string;
      providerCreatedAt: Date;
      suspended: boolean;
    }
  | {
      event: "User.Deleted";
      hookId: string;
      providerSubject: string;
      providerCreatedAt: Date;
    };

type IdentityRecord = {
  id: string;
  accountId: string;
  status: AuthIdentityStatus;
  account: { id: string; status: AccountStatus };
};

type LogtoLifecycleTransaction = {
  logtoWebhookReceipt: {
    findUnique(args: unknown): Promise<{ id: string } | null>;
    findFirst(args: unknown): Promise<{
      providerCreatedAt: Date;
    } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
  authIdentity: {
    findUnique(args: unknown): Promise<IdentityRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  account: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  appSession: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

export type LogtoLifecycleClient = {
  $transaction<T>(
    operation: (tx: LogtoLifecycleTransaction) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export type LogtoLifecycleResult = {
  status: "processed" | "duplicate" | "ignored";
  effect:
    | "SUSPENDED"
    | "REACTIVATED"
    | "DELETION_PENDING"
    | "IDENTITY_NOT_FOUND"
    | "STALE_EVENT_IGNORED"
    | "TEST_EVENT_IGNORED"
    | "NO_CHANGE";
  revokedSessions: number;
};

export function readLogtoWebhookSigningKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.LOGTO_WEBHOOK_SIGNING_KEY?.trim();
  if (!key) {
    throw new Error("LOGTO_WEBHOOK_SIGNING_KEY is required.");
  }
  return key;
}

export function verifyLogtoWebhookSignature(input: {
  rawBody: string;
  signature: string | null | undefined;
  signingKey: string;
}): boolean {
  const expected = createHmac("sha256", input.signingKey)
    .update(input.rawBody, "utf8")
    .digest("hex");
  const received = input.signature?.trim().toLowerCase();
  if (!received || !/^[a-f0-9]{64}$/u.test(received)) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export async function processLogtoLifecycleWebhook(
  input: {
    rawBody: string;
    signature: string | null | undefined;
    env?: Record<string, string | undefined> | undefined;
    now?: Date | undefined;
  },
  client: LogtoLifecycleClient = prisma as unknown as LogtoLifecycleClient,
): Promise<LogtoLifecycleResult> {
  const env = input.env ?? process.env;
  if (
    Buffer.byteLength(input.rawBody, "utf8")
    > MAX_LOGTO_WEBHOOK_BODY_BYTES
  ) {
    throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
  }
  const signingKey = readLogtoWebhookSigningKey(env);
  if (
    !verifyLogtoWebhookSignature({
      rawBody: input.rawBody,
      signature: input.signature,
      signingKey,
    })
  ) {
    throw new LogtoWebhookError("INVALID_SIGNATURE", 401);
  }
  const event = parseLogtoLifecycleEvent(input.rawBody);
  const issuer = readLogtoIssuer(env);
  const payloadHash = createHash("sha256")
    .update(input.rawBody, "utf8")
    .digest("hex");
  const processedAt = input.now ?? new Date();

  try {
    return await client.$transaction(
      async (tx) => {
        const existing = await tx.logtoWebhookReceipt.findUnique({
          where: { payloadHash },
          select: { id: true },
        });
        if (existing) {
          return {
            status: "duplicate",
            effect: "NO_CHANGE",
            revokedSessions: 0,
          };
        }

        if (event.event === "Logto.Test") {
          await createReceipt(tx, {
            event,
            issuer,
            payloadHash,
            processedAt,
            effect: "TEST_EVENT_IGNORED",
          });
          return {
            status: "ignored",
            effect: "TEST_EVENT_IGNORED",
            revokedSessions: 0,
          };
        }

        if (event.event === "User.SuspensionStatus.Updated") {
          const latest = await tx.logtoWebhookReceipt.findFirst({
            where: {
              issuer,
              providerSubject: event.providerSubject,
              event: event.event,
            },
            orderBy: [{ providerCreatedAt: "desc" }, { createdAt: "desc" }],
            select: { providerCreatedAt: true },
          });
          if (
            latest
            && latest.providerCreatedAt.getTime()
              > event.providerCreatedAt.getTime()
          ) {
            await createReceipt(tx, {
              event,
              issuer,
              payloadHash,
              processedAt,
              effect: "STALE_EVENT_IGNORED",
            });
            return {
              status: "ignored",
              effect: "STALE_EVENT_IGNORED",
              revokedSessions: 0,
            };
          }
        }

        const identity = await tx.authIdentity.findUnique({
          where: {
            provider_issuer_subject: {
              provider: AuthIdentityProvider.LOGTO,
              issuer,
              subject: event.providerSubject,
            },
          },
          include: { account: true },
        });
        if (!identity) {
          await createReceipt(tx, {
            event,
            issuer,
            payloadHash,
            processedAt,
            effect: "IDENTITY_NOT_FOUND",
          });
          return {
            status: "ignored",
            effect: "IDENTITY_NOT_FOUND",
            revokedSessions: 0,
          };
        }

        const transition = await applyIdentityLifecycleState(
          tx,
          identity,
          event.event === "User.Deleted"
            ? "DELETED"
            : event.suspended
              ? "SUSPENDED"
              : "ACTIVE",
          processedAt,
        );

        await createReceipt(tx, {
          event,
          issuer,
          payloadHash,
          processedAt,
          effect: transition.effect,
        });
        return { status: "processed", ...transition };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        status: "duplicate",
        effect: "NO_CHANGE",
        revokedSessions: 0,
      };
    }
    throw error;
  }
}

export async function reconcileLogtoIdentityLifecycleState(
  input: {
    issuer: string;
    providerSubject: string;
    state: "ACTIVE" | "SUSPENDED" | "DELETED";
    now?: Date | undefined;
  },
  client: LogtoLifecycleClient = prisma as unknown as LogtoLifecycleClient,
): Promise<LogtoLifecycleResult> {
  const issuer = input.issuer.trim();
  const providerSubject = input.providerSubject.trim();
  if (!issuer || !providerSubject) {
    throw new Error("issuer and providerSubject are required for reconciliation.");
  }
  return client.$transaction(
    async (tx) => {
      const identity = await tx.authIdentity.findUnique({
        where: {
          provider_issuer_subject: {
            provider: AuthIdentityProvider.LOGTO,
            issuer,
            subject: providerSubject,
          },
        },
        include: { account: true },
      });
      if (!identity) {
        return {
          status: "ignored",
          effect: "IDENTITY_NOT_FOUND",
          revokedSessions: 0,
        };
      }
      const transition = await applyIdentityLifecycleState(
        tx,
        identity,
        input.state,
        input.now ?? new Date(),
      );
      return { status: "processed", ...transition };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export class LogtoWebhookError extends Error {
  constructor(
    readonly code:
      | "INVALID_SIGNATURE"
      | "INVALID_PAYLOAD"
      | "UNSUPPORTED_EVENT",
    readonly statusCode: 400 | 401,
  ) {
    super(code);
    this.name = "LogtoWebhookError";
  }
}

function parseLogtoLifecycleEvent(rawBody: string): LogtoLifecycleEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
  }
  if (!isRecord(payload)) {
    throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
  }
  const hookId = requiredString(payload.hookId);
  const event = requiredString(payload.event);
  if (
    event === "User.SuspensionStatus.Updated"
    && Boolean(hookId)
    && isRecord(payload.data)
    && payload.data.result === "success"
    && payload.data.id === undefined
    && payload.data.isSuspended === undefined
    && isRecord(payload.params)
    && payload.params.id === "fake-id"
  ) {
    const testCreatedAt = new Date(requiredString(payload.createdAt));
    return {
      event: "Logto.Test",
      hookId,
      providerSubject: "fake-id",
      providerCreatedAt: Number.isFinite(testCreatedAt.getTime())
        ? testCreatedAt
        : new Date(0),
    };
  }
  const providerCreatedAt = new Date(requiredString(payload.createdAt));
  if (!hookId || !Number.isFinite(providerCreatedAt.getTime())) {
    throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
  }

  if (event === "User.SuspensionStatus.Updated") {
    const data = isRecord(payload.data) ? payload.data : null;
    const providerSubject = data ? requiredString(data.id) : "";
    if (!providerSubject || typeof data?.isSuspended !== "boolean") {
      throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
    }
    return {
      event,
      hookId,
      providerSubject,
      providerCreatedAt,
      suspended: data.isSuspended,
    };
  }
  if (event === "User.Deleted") {
    const params = isRecord(payload.params) ? payload.params : null;
    const providerSubject =
      requiredString(params?.userId)
      || requiredString(params?.id);
    if (!providerSubject) {
      throw new LogtoWebhookError("INVALID_PAYLOAD", 400);
    }
    return {
      event,
      hookId,
      providerSubject,
      providerCreatedAt,
    };
  }
  throw new LogtoWebhookError("UNSUPPORTED_EVENT", 400);
}

async function createReceipt(
  tx: LogtoLifecycleTransaction,
  input: {
    event: LogtoLifecycleEvent;
    issuer: string;
    payloadHash: string;
    processedAt: Date;
    effect: LogtoLifecycleResult["effect"];
  },
) {
  await tx.logtoWebhookReceipt.create({
    data: {
      issuer: input.issuer,
      hookId: input.event.hookId,
      event: input.event.event,
      providerSubject: input.event.providerSubject,
      payloadHash: input.payloadHash,
      providerCreatedAt: input.event.providerCreatedAt,
      processedAt: input.processedAt,
      effect: input.effect,
    },
  });
}

async function revokeSessions(
  tx: LogtoLifecycleTransaction,
  accountId: string,
  revokedAt: Date,
  revokedReason: string,
) {
  const result = await tx.appSession.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt, revokedReason },
  });
  return result.count;
}

async function applyIdentityLifecycleState(
  tx: LogtoLifecycleTransaction,
  identity: IdentityRecord,
  state: "ACTIVE" | "SUSPENDED" | "DELETED",
  processedAt: Date,
): Promise<Pick<LogtoLifecycleResult, "effect" | "revokedSessions">> {
  if (state === "DELETED") {
    await tx.authIdentity.updateMany({
      where: { id: identity.id },
      data: { status: AuthIdentityStatus.REVOKED },
    });
    await tx.account.updateMany({
      where: {
        id: identity.accountId,
        status: {
          in: [AccountStatus.ACTIVE, AccountStatus.SUSPENDED],
        },
      },
      data: { status: AccountStatus.DELETION_PENDING },
    });
    return {
      effect: "DELETION_PENDING",
      revokedSessions: await revokeSessions(
        tx,
        identity.accountId,
        processedAt,
        "LOGTO_USER_DELETED",
      ),
    };
  }
  if (state === "SUSPENDED") {
    const updated = await tx.authIdentity.updateMany({
      where: {
        id: identity.id,
        status: AuthIdentityStatus.ACTIVE,
      },
      data: { status: AuthIdentityStatus.SUSPENDED },
    });
    const revokedSessions =
      identity.status !== AuthIdentityStatus.REVOKED
        ? await revokeSessions(
            tx,
            identity.accountId,
            processedAt,
            "LOGTO_USER_SUSPENDED",
          )
        : 0;
    return {
      effect: updated.count === 1 ? "SUSPENDED" : "NO_CHANGE",
      revokedSessions,
    };
  }
  if (
    identity.status === AuthIdentityStatus.SUSPENDED
    && identity.account.status === AccountStatus.ACTIVE
  ) {
    const updated = await tx.authIdentity.updateMany({
      where: {
        id: identity.id,
        status: AuthIdentityStatus.SUSPENDED,
        account: { status: AccountStatus.ACTIVE },
      },
      data: { status: AuthIdentityStatus.ACTIVE },
    });
    return {
      effect: updated.count === 1 ? "REACTIVATED" : "NO_CHANGE",
      revokedSessions: 0,
    };
  }
  return { effect: "NO_CHANGE", revokedSessions: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
  );
}
