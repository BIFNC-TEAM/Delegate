import { createHash, randomUUID } from "node:crypto";

import {
  RepresentativeChannelKind,
  ChannelSourceProvider,
  ChannelTransport,
  Prisma,
} from "@prisma/client";

import { prisma } from "./prisma";
import { requireTelegramRuntimeContext } from "./telegram-runtime-context";

export type TelegramMessageEditEvent = {
  updateId: number;
  telegramUserId: number;
  chatId: string;
  externalMessageId: string;
  text: string;
  editedAt: string;
};

export type TelegramMessageEditLease = {
  inboxId: string;
  leaseToken: string;
};

export type TelegramMessageEditApply = (
  event: TelegramMessageEditEvent,
  lease: TelegramMessageEditLease,
) => Promise<{
  conversationId: string;
  providerEditStatus: "applied" | "superseded";
}>;

export type TelegramMessageEditProcessingResult = {
  status: "processed" | "retrying" | "superseded" | "terminal";
};

type TelegramMessageEditErrorCode =
  | "telegram_edit_invalid_payload"
  | "telegram_edit_target_not_found"
  | "telegram_edit_scope_invalid"
  | "telegram_edit_message_redacted"
  | "telegram_edit_delegation_conflict"
  | "telegram_edit_processing_failed";

export class TelegramMessageEditNotDurableError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Telegram message edit could not be durably recorded.");
    this.name = "TelegramMessageEditNotDurableError";
    this.cause = cause;
  }
}

export class TelegramMessageEditRetryableError extends Error {
  readonly code: TelegramMessageEditErrorCode;

  constructor(code: TelegramMessageEditErrorCode) {
    super(code);
    this.name = "TelegramMessageEditRetryableError";
    this.code = code;
  }
}

export class TelegramMessageEditTerminalError extends Error {
  readonly code: TelegramMessageEditErrorCode;

  constructor(code: TelegramMessageEditErrorCode) {
    super(code);
    this.name = "TelegramMessageEditTerminalError";
    this.code = code;
  }
}

export class TelegramMessageEditLeaseLostError extends Error {
  constructor() {
    super("telegram_edit_lease_lost");
    this.name = "TelegramMessageEditLeaseLostError";
  }
}

const telegramMessageEditEventType = "telegram.edited_message";
const telegramMessageEditProcessingLeaseMs = 30_000;
const telegramMessageEditMaximumBackoffMs = 15 * 60_000;

type TelegramMessageEditClaim = {
  id: string;
  payload: Prisma.JsonValue;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export async function persistAndProcessTelegramMessageEdit(
  rawEvent: TelegramMessageEditEvent,
  apply: TelegramMessageEditApply,
): Promise<TelegramMessageEditProcessingResult> {
  let event: TelegramMessageEditEvent;
  let inboxId: string;
  try {
    event = normalizeTelegramMessageEditEvent(rawEvent);
    const connectionId = requireTelegramRuntimeContext().botId;
    const externalEventId = `${connectionId}:edit:${event.updateId}`;
    const inbox = await prisma.channelEventInbox.upsert({
      where: {
        kind_connectionId_externalEventId: {
          kind: RepresentativeChannelKind.TELEGRAM,
          connectionId,
          externalEventId,
        },
      },
      create: {
        kind: RepresentativeChannelKind.TELEGRAM,
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        connectionId,
        originKey: `telegram:${connectionId}:message-edit:${event.updateId}`,
        transactionId: telegramMessageEditTargetKey(event),
        externalEventId,
        eventType: telegramMessageEditEventType,
        payload: event as Prisma.InputJsonObject,
        status: "PENDING",
        attemptCount: 0,
      },
      update: {},
      select: { id: true },
    });
    inboxId = inbox.id;
  } catch (error) {
    throw new TelegramMessageEditNotDurableError(error);
  }

  return processTelegramMessageEditInbox(inboxId, apply);
}

export async function retryPendingTelegramMessageEdits(
  apply: TelegramMessageEditApply,
  limit = 20,
): Promise<{
  examined: number;
  processed: number;
  retrying: number;
  superseded: number;
  terminal: number;
}> {
  const connectionId = requireTelegramRuntimeContext().botId;
  const now = new Date();
  const rows = await prisma.channelEventInbox.findMany({
    where: {
      kind: RepresentativeChannelKind.TELEGRAM,
      connectionId,
      eventType: telegramMessageEditEventType,
      OR: [
        {
          status: { in: ["PENDING", "FAILED"] },
          availableAt: { lte: now },
        },
        {
          status: "PROCESSING",
          leaseExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, Math.trunc(limit))),
    select: { id: true },
  });
  let processed = 0;
  let retrying = 0;
  let superseded = 0;
  let terminal = 0;
  for (const row of rows) {
    const result = await processTelegramMessageEditInbox(row.id, apply);
    if (result.status === "processed") processed += 1;
    else if (result.status === "superseded") superseded += 1;
    else if (result.status === "terminal") terminal += 1;
    else retrying += 1;
  }
  return { examined: rows.length, processed, retrying, superseded, terminal };
}

/**
 * Only deterministic invalid/scope failures enter DEAD_LETTER. Retryable
 * safety controls stay in automatic reconciliation without a finite ceiling.
 * An operator may still provide the original provider event to explicitly
 * replay a corrected deterministic failure.
 */
export async function replayTelegramMessageEditInbox(
  input: { inboxId: string; event: TelegramMessageEditEvent },
  apply: TelegramMessageEditApply,
): Promise<TelegramMessageEditProcessingResult> {
  const event = normalizeTelegramMessageEditEvent(input.event);
  const connectionId = requireTelegramRuntimeContext().botId;
  const externalEventId = `${connectionId}:edit:${event.updateId}`;
  const replayed = await prisma.channelEventInbox.updateMany({
    where: {
      id: input.inboxId,
      kind: RepresentativeChannelKind.TELEGRAM,
      connectionId,
      externalEventId,
      eventType: telegramMessageEditEventType,
      transactionId: telegramMessageEditTargetKey(event),
      status: "DEAD_LETTER",
      leaseToken: null,
      leaseExpiresAt: null,
    },
    data: {
      payload: event as Prisma.InputJsonObject,
      status: "PENDING",
      attemptCount: 0,
      availableAt: new Date(),
      processedAt: null,
      lastError: null,
    },
  });
  if (replayed.count !== 1) {
    throw new Error("Telegram message edit is not eligible for explicit replay.");
  }
  return processTelegramMessageEditInbox(input.inboxId, apply);
}

/**
 * Locks the inbox row inside the same PostgreSQL transaction as the Message
 * mutation. A reclaimed or expired worker therefore cannot mutate the body.
 */
export async function lockTelegramMessageEditLease(
  tx: Prisma.TransactionClient,
  lease: TelegramMessageEditLease,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT inbox."id"
      FROM "ChannelEventInbox" AS inbox
     WHERE inbox."id" = ${lease.inboxId}
       AND inbox."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
       AND inbox."eventType" = ${telegramMessageEditEventType}
       AND inbox."status" = 'PROCESSING'::"ReliableEventStatus"
       AND inbox."leaseToken" = ${lease.leaseToken}
       AND inbox."leaseExpiresAt" > clock_timestamp()
     FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new TelegramMessageEditLeaseLostError();
  }
}

async function processTelegramMessageEditInbox(
  inboxId: string,
  apply: TelegramMessageEditApply,
): Promise<TelegramMessageEditProcessingResult> {
  const claim = await claimTelegramMessageEditInbox(inboxId);
  if (!claim) {
    const current = await prisma.channelEventInbox.findUnique({
      where: { id: inboxId },
      select: { status: true },
    });
    if (current?.status === "PROCESSED") return { status: "processed" };
    if (current?.status === "DEAD_LETTER") return { status: "terminal" };
    return { status: "retrying" };
  }

  let event: TelegramMessageEditEvent;
  try {
    event = parseTelegramMessageEditEvent(claim.payload);
  } catch (error) {
    const terminal = await terminalizeTelegramMessageEditInbox({
      claim,
      payload: claim.payload,
      code: "telegram_edit_invalid_payload",
    });
    return { status: terminal ? "terminal" : "retrying" };
  }

  try {
    const applied = await apply(event, {
      inboxId: claim.id,
      leaseToken: claim.leaseToken,
    });
    const completed = await completeTelegramMessageEditInbox({
      claim,
      event,
      conversationId: applied.conversationId,
    });
    if (!completed) return { status: "retrying" };
    return {
      status: applied.providerEditStatus === "superseded"
        ? "superseded"
        : "processed",
    };
  } catch (error) {
    if (error instanceof TelegramMessageEditLeaseLostError) {
      return { status: "retrying" };
    }
    const disposition = classifyTelegramMessageEditError(error);
    if (!disposition.retryable) {
      const terminal = await terminalizeTelegramMessageEditInbox({
        claim,
        payload: event as unknown as Prisma.JsonValue,
        code: disposition.code,
      });
      return { status: terminal ? "terminal" : "retrying" };
    }
    await failTelegramMessageEditInbox({
      claim,
      code: disposition.code,
    });
    return { status: "retrying" };
  }
}

async function claimTelegramMessageEditInbox(
  inboxId: string,
): Promise<TelegramMessageEditClaim | null> {
  const leaseToken = randomUUID();
  const claims = await prisma.$queryRaw<TelegramMessageEditClaim[]>(Prisma.sql`
    UPDATE "ChannelEventInbox" AS inbox
       SET "status" = 'PROCESSING'::"ReliableEventStatus",
           "attemptCount" = inbox."attemptCount" + 1,
           "availableAt" = clock_timestamp()
             + (${telegramMessageEditProcessingLeaseMs} * INTERVAL '1 millisecond'),
           "leaseToken" = ${leaseToken},
           "leaseExpiresAt" = clock_timestamp()
             + (${telegramMessageEditProcessingLeaseMs} * INTERVAL '1 millisecond'),
           "processedAt" = NULL,
           "lastError" = NULL,
           "updatedAt" = clock_timestamp()
     WHERE inbox."id" = ${inboxId}
       AND inbox."kind" = 'TELEGRAM'::"RepresentativeChannelKind"
       AND inbox."eventType" = ${telegramMessageEditEventType}
       AND (
         (
           inbox."status" IN (
             'PENDING'::"ReliableEventStatus",
             'FAILED'::"ReliableEventStatus"
           )
           AND inbox."availableAt" <= clock_timestamp()
         )
         OR (
           inbox."status" = 'PROCESSING'::"ReliableEventStatus"
           AND inbox."leaseExpiresAt" <= clock_timestamp()
         )
       )
    RETURNING inbox."id",
              inbox."payload",
              inbox."attemptCount",
              inbox."leaseToken",
              inbox."leaseExpiresAt"
  `);
  return claims[0] ?? null;
}

async function completeTelegramMessageEditInbox(input: {
  claim: TelegramMessageEditClaim;
  event: TelegramMessageEditEvent;
  conversationId: string;
}) {
  const payload = JSON.stringify(sanitizeTelegramMessageEditPayload(input.event));
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "ChannelEventInbox" AS inbox
       SET "conversationId" = ${input.conversationId},
           "payload" = ${payload}::jsonb,
           "status" = 'PROCESSED'::"ReliableEventStatus",
           "processedAt" = clock_timestamp(),
           "availableAt" = clock_timestamp(),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastError" = NULL,
           "updatedAt" = clock_timestamp()
     WHERE inbox."id" = ${input.claim.id}
       AND inbox."status" = 'PROCESSING'::"ReliableEventStatus"
       AND inbox."leaseToken" = ${input.claim.leaseToken}
       AND inbox."leaseExpiresAt" > clock_timestamp()
    RETURNING inbox."id"
  `);
  return rows.length === 1;
}

async function failTelegramMessageEditInbox(input: {
  claim: TelegramMessageEditClaim;
  code: TelegramMessageEditErrorCode;
}) {
  const backoffMilliseconds = Math.min(
    telegramMessageEditMaximumBackoffMs,
    2 ** Math.min(input.claim.attemptCount, 10) * 1_000,
  );
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "ChannelEventInbox" AS inbox
       SET "status" = 'FAILED'::"ReliableEventStatus",
           "processedAt" = NULL,
           "availableAt" = clock_timestamp()
             + (${backoffMilliseconds} * INTERVAL '1 millisecond'),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastError" = ${input.code},
           "updatedAt" = clock_timestamp()
     WHERE inbox."id" = ${input.claim.id}
       AND inbox."status" = 'PROCESSING'::"ReliableEventStatus"
       AND inbox."leaseToken" = ${input.claim.leaseToken}
       AND inbox."leaseExpiresAt" > clock_timestamp()
    RETURNING inbox."id"
  `);
  return rows.length === 1;
}

async function terminalizeTelegramMessageEditInbox(input: {
  claim: TelegramMessageEditClaim;
  payload: Prisma.JsonValue;
  code: TelegramMessageEditErrorCode;
}) {
  const sanitizedPayload = JSON.stringify(
    sanitizeTelegramMessageEditPayload(input.payload),
  );
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "ChannelEventInbox" AS inbox
       SET "payload" = ${sanitizedPayload}::jsonb,
           "status" = 'DEAD_LETTER'::"ReliableEventStatus",
           "processedAt" = clock_timestamp(),
           "availableAt" = clock_timestamp(),
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "lastError" = ${input.code},
           "updatedAt" = clock_timestamp()
     WHERE inbox."id" = ${input.claim.id}
       AND inbox."status" = 'PROCESSING'::"ReliableEventStatus"
       AND inbox."leaseToken" = ${input.claim.leaseToken}
       AND inbox."leaseExpiresAt" > clock_timestamp()
    RETURNING inbox."id"
  `);
  return rows.length === 1;
}

function normalizeTelegramMessageEditEvent(
  event: TelegramMessageEditEvent,
): TelegramMessageEditEvent {
  const chatId = event.chatId.trim();
  const externalMessageId = event.externalMessageId.trim();
  const text = event.text.trim();
  const editedAt = new Date(event.editedAt);
  if (
    !Number.isSafeInteger(event.updateId)
    || event.updateId < 0
    || !Number.isSafeInteger(event.telegramUserId)
    || event.telegramUserId <= 0
    || !chatId
    || !externalMessageId
    || !text
    || !Number.isFinite(editedAt.getTime())
  ) {
    throw new Error("Telegram message edit coordinates are invalid.");
  }
  return {
    updateId: event.updateId,
    telegramUserId: event.telegramUserId,
    chatId,
    externalMessageId,
    text,
    editedAt: editedAt.toISOString(),
  };
}

function parseTelegramMessageEditEvent(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telegram message edit payload is invalid.");
  }
  const payload = value as Record<string, unknown>;
  return normalizeTelegramMessageEditEvent({
    updateId: payload.updateId as number,
    telegramUserId: payload.telegramUserId as number,
    chatId: payload.chatId as string,
    externalMessageId: payload.externalMessageId as string,
    text: payload.text as string,
    editedAt: payload.editedAt as string,
  });
}

function sanitizeTelegramMessageEditPayload(
  value: TelegramMessageEditEvent | Prisma.JsonValue,
): Prisma.InputJsonObject {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const sanitized: Record<string, Prisma.InputJsonValue> = {};
  if (Number.isSafeInteger(payload.updateId) && Number(payload.updateId) >= 0) {
    sanitized.updateId = Number(payload.updateId);
  }
  if (
    Number.isSafeInteger(payload.telegramUserId)
    && Number(payload.telegramUserId) > 0
  ) {
    sanitized.telegramUserId = Number(payload.telegramUserId);
  }
  for (const key of ["chatId", "externalMessageId"] as const) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      sanitized[key] = payload[key].trim().slice(0, 256);
    }
  }
  if (
    typeof payload.editedAt === "string"
    && Number.isFinite(new Date(payload.editedAt).getTime())
  ) {
    sanitized.editedAt = new Date(payload.editedAt).toISOString();
  }
  sanitized.bodySha256 = createHash("sha256")
    .update(typeof payload.text === "string" ? payload.text : "", "utf8")
    .digest("hex");
  return sanitized as Prisma.InputJsonObject;
}

function telegramMessageEditTargetKey(event: TelegramMessageEditEvent) {
  return `edit:${event.chatId}:${event.externalMessageId}`;
}

function classifyTelegramMessageEditError(error: unknown): {
  retryable: boolean;
  code: TelegramMessageEditErrorCode;
} {
  if (error instanceof TelegramMessageEditTerminalError) {
    return { retryable: false, code: error.code };
  }
  if (error instanceof TelegramMessageEditRetryableError) {
    return { retryable: true, code: error.code };
  }
  return { retryable: true, code: "telegram_edit_processing_failed" };
}
