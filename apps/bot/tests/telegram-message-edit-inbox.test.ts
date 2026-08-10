import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    channelEventInbox: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import {
  persistAndProcessTelegramMessageEdit,
  replayTelegramMessageEditInbox,
  retryPendingTelegramMessageEdits,
  TelegramMessageEditNotDurableError,
  TelegramMessageEditTerminalError,
} from "../src/telegram-message-edit-inbox";
import { runWithTelegramRuntimeContext } from "../src/telegram-runtime-context";

const edit = {
  updateId: 42,
  telegramUserId: 123456,
  chatId: "123456",
  externalMessageId: "77",
  text: "Corrected message",
  editedAt: "2026-08-06T12:00:00.000Z",
};

const runtime = {
  internalConnectionId: "telegram-connection-1",
  botId: "777000",
};

const claim = {
  id: "edit-inbox-1",
  payload: edit,
  attemptCount: 1,
  leaseToken: "edit-lease-1",
  leaseExpiresAt: new Date("2026-08-06T12:01:00.000Z"),
};

describe("Telegram message edit durable inbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.channelEventInbox.upsert.mockResolvedValue({
      id: "edit-inbox-1",
    });
    mockPrisma.channelEventInbox.findUnique.mockResolvedValue({
      status: "PROCESSING",
    });
    mockPrisma.channelEventInbox.findMany.mockResolvedValue([]);
    mockPrisma.channelEventInbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const sql = query.sql as string;
      if (sql.includes(
        'SET "status" = \'PROCESSING\'::"ReliableEventStatus"',
      )) return [claim];
      return [{ id: "edit-inbox-1" }];
    });
  });

  it("persists first, then applies under the claimed owner lease", async () => {
    const apply = vi.fn().mockResolvedValue({
      conversationId: "conversation-1",
      providerEditStatus: "applied",
    });

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, apply),
    )).resolves.toEqual({ status: "processed" });

    expect(mockPrisma.channelEventInbox.upsert).toHaveBeenCalledWith({
      where: {
        kind_connectionId_externalEventId: {
          kind: "TELEGRAM",
          connectionId: "777000",
          externalEventId: "777000:edit:42",
        },
      },
      create: expect.objectContaining({
        kind: "TELEGRAM",
        transport: "TELEGRAM",
        sourceProvider: "TELEGRAM",
        connectionId: "777000",
        originKey: "telegram:777000:message-edit:42",
        transactionId: "edit:123456:77",
        externalEventId: "777000:edit:42",
        eventType: "telegram.edited_message",
        payload: edit,
        status: "PENDING",
        attemptCount: 0,
      }),
      update: {},
      select: { id: true },
    });
    expect(apply).toHaveBeenCalledWith(edit, {
      inboxId: "edit-inbox-1",
      leaseToken: "edit-lease-1",
    });
    expect(mockPrisma.channelEventInbox.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(apply.mock.invocationCallOrder[0]!);

    const completion = rawQueryContaining('SET "conversationId"');
    expect(completion.sql).toContain('inbox."leaseToken" =');
    expect(completion.sql).toContain('inbox."leaseExpiresAt" > clock_timestamp()');
    const retainedPayload = jsonQueryValue(completion);
    expect(retainedPayload).toEqual({
      updateId: 42,
      telegramUserId: 123456,
      chatId: "123456",
      externalMessageId: "77",
      editedAt: "2026-08-06T12:00:00.000Z",
      bodySha256: createHash("sha256").update(edit.text).digest("hex"),
    });
    expect(JSON.stringify(retainedPayload)).not.toContain(edit.text);
  });

  it("stores only a retryable whitelist code and owner-CASes failure", async () => {
    const apply = vi.fn().mockRejectedValue(
      new Error("database unavailable with sensitive driver detail"),
    );

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, apply),
    )).resolves.toEqual({ status: "retrying" });

    const failure = rawQueryContaining(
      'SET "status" = \'FAILED\'::"ReliableEventStatus"',
    );
    expect(failure.sql).toContain('inbox."leaseToken" =');
    expect(failure.sql).toContain('inbox."leaseExpiresAt" > clock_timestamp()');
    expect(failure.values).toContain("telegram_edit_processing_failed");
    expect(failure.values).not.toContain(
      "database unavailable with sensitive driver detail",
    );
  });

  it("does not let an expired worker overwrite a successor state", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const sql = query.sql as string;
      if (sql.includes(
        'SET "status" = \'PROCESSING\'::"ReliableEventStatus"',
      )) return [claim];
      if (sql.includes('SET "status" = \'FAILED\'::"ReliableEventStatus"')) {
        return [];
      }
      return [{ id: "edit-inbox-1" }];
    });
    const apply = vi.fn().mockRejectedValue(new Error("late worker"));

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, apply),
    )).resolves.toEqual({ status: "retrying" });

    expect(rawQueryContaining(
      'SET "status" = \'FAILED\'::"ReliableEventStatus"',
    ).sql)
      .toContain('inbox."leaseToken" =');
  });

  it("uses the atomic Message watermark outcome instead of sibling prechecks", async () => {
    const apply = vi.fn().mockResolvedValue({
      conversationId: "conversation-1",
      providerEditStatus: "superseded",
    });

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, apply),
    )).resolves.toEqual({ status: "superseded" });

    expect(mockPrisma.channelEventInbox.findMany).not.toHaveBeenCalled();
    expect(rawQueryContaining('SET "conversationId"')).toBeDefined();
  });

  it("terminalizes deterministic errors immediately and removes the body", async () => {
    const apply = vi.fn().mockRejectedValue(
      new TelegramMessageEditTerminalError("telegram_edit_scope_invalid"),
    );

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, apply),
    )).resolves.toEqual({ status: "terminal" });

    const terminal = rawQueryContaining("'DEAD_LETTER'::\"ReliableEventStatus\"");
    expect(terminal.values).toContain("telegram_edit_scope_invalid");
    const retainedPayload = jsonQueryValue(terminal);
    expect(JSON.stringify(retainedPayload)).not.toContain(edit.text);
    expect(retainedPayload.bodySha256).toBe(
      createHash("sha256").update(edit.text).digest("hex"),
    );
  });

  it("keeps retryable safety controls in automatic reconciliation", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const sql = query.sql as string;
      if (sql.includes(
        'SET "status" = \'PROCESSING\'::"ReliableEventStatus"',
      )) {
        return [{ ...claim, attemptCount: 500 }];
      }
      return [{ id: "edit-inbox-1" }];
    });

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(
        edit,
        vi.fn().mockRejectedValue(new Error("temporary")),
      ),
    )).resolves.toEqual({ status: "retrying" });

    expect(rawQueryContaining(
      'SET "status" = \'FAILED\'::"ReliableEventStatus"',
    )).toBeDefined();
    expect(mockPrisma.$queryRaw.mock.calls.some(([query]) =>
      (query as { sql: string }).sql.includes(
        "'DEAD_LETTER'::\"ReliableEventStatus\"",
      )
    )).toBe(false);
  });

  it("reclaims an expired lease without a finite retry ceiling", async () => {
    mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
      const sql = query.sql as string;
      if (sql.includes(
        'SET "status" = \'PROCESSING\'::"ReliableEventStatus"',
      )) {
        return [{ ...claim, attemptCount: 501 }];
      }
      return [{ id: "edit-inbox-1" }];
    });
    mockPrisma.channelEventInbox.findMany.mockResolvedValueOnce([
      { id: "edit-inbox-1" },
    ]);
    const apply = vi.fn().mockResolvedValue({
      conversationId: "conversation-1",
      providerEditStatus: "applied",
    });

    await expect(withRuntime(() =>
      retryPendingTelegramMessageEdits(apply),
    )).resolves.toMatchObject({ processed: 1, terminal: 0 });

    expect(apply).toHaveBeenCalledOnce();
    const claimQuery = mockPrisma.$queryRaw.mock.calls
      .map(([query]) => query as { sql: string })
      .find((query) => query.sql.includes(
        'SET "status" = \'PROCESSING\'::"ReliableEventStatus"',
      ));
    expect(claimQuery?.sql).not.toContain('inbox."attemptCount" <');
  });

  it("never automatically claims DEAD_LETTER and exposes explicit replay", async () => {
    mockPrisma.channelEventInbox.findMany.mockResolvedValueOnce([
      { id: "edit-inbox-1" },
    ]);
    const apply = vi.fn().mockResolvedValue({
      conversationId: "conversation-1",
      providerEditStatus: "applied",
    });

    await expect(withRuntime(() =>
      retryPendingTelegramMessageEdits(apply),
    )).resolves.toEqual({
      examined: 1,
      processed: 1,
      retrying: 0,
      superseded: 0,
      terminal: 0,
    });

    const retryWhere = mockPrisma.channelEventInbox.findMany.mock.calls[0]![0]
      .where;
    expect(JSON.stringify(retryWhere)).not.toContain("DEAD_LETTER");
    expect(retryWhere.OR).toEqual([
      {
        status: { in: ["PENDING", "FAILED"] },
        availableAt: { lte: expect.any(Date) },
      },
      {
        status: "PROCESSING",
        leaseExpiresAt: { lte: expect.any(Date) },
      },
    ]);

    await expect(withRuntime(() => replayTelegramMessageEditInbox(
      { inboxId: "edit-inbox-1", event: edit },
      apply,
    ))).resolves.toEqual({ status: "processed" });
    expect(mockPrisma.channelEventInbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "DEAD_LETTER" }),
        data: expect.objectContaining({
          payload: edit,
          status: "PENDING",
          attemptCount: 0,
        }),
      }),
    );
  });

  it("escalates an update that could not be durably persisted", async () => {
    mockPrisma.channelEventInbox.upsert.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(withRuntime(() =>
      persistAndProcessTelegramMessageEdit(edit, vi.fn()),
    )).rejects.toBeInstanceOf(TelegramMessageEditNotDurableError);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});

function rawQueryContaining(fragment: string) {
  const query = mockPrisma.$queryRaw.mock.calls
    .map(([value]) => value as { sql: string; values: unknown[] })
    .find((value) => value.sql.includes(fragment));
  if (!query) throw new Error(`Expected raw query containing ${fragment}`);
  return query;
}

function jsonQueryValue(query: { values: unknown[] }) {
  const serialized = query.values.find((value) =>
    typeof value === "string" && value.includes('"bodySha256"')
  );
  if (typeof serialized !== "string") {
    throw new Error("Expected sanitized JSON payload in query values.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function withRuntime<T>(operation: () => T): T {
  return runWithTelegramRuntimeContext(runtime, operation);
}
