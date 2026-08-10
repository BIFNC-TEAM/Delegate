import { MemoryExpiryAction, Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  buildMemoryChannelDisclosureDescriptor,
  hasCurrentMemoryChannelDisclosureForMessage,
  memoryChannelDisclosureContractVersion,
} from "../src/memory-disclosure";

const policy = {
  revision: 7,
  longTermMemoryEnabled: true,
  shortTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: false,
  representativeExperienceEnabled: true,
  autoExtract: true,
  matrixRecallEnabled: true,
  matrixExtractEnabled: true,
  telegramRecallEnabled: false,
  telegramExtractEnabled: false,
  retentionDays: 30,
  expiryAction: MemoryExpiryAction.ARCHIVE,
};

describe("private-channel memory disclosure", () => {
  it("binds the descriptor to channel, policy revision, and exact text", () => {
    const first = buildMemoryChannelDisclosureDescriptor({
      channel: "matrix",
      policy,
    });
    const replay = buildMemoryChannelDisclosureDescriptor({
      channel: "matrix",
      policy,
    });
    const telegram = buildMemoryChannelDisclosureDescriptor({
      channel: "telegram",
      policy,
    });

    expect(first).toEqual(replay);
    expect(first.contractVersion).toBe(memoryChannelDisclosureContractVersion);
    expect(first.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.disclosureHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.snapshot).toMatchObject({
      channel: "matrix",
      policyRevision: 7,
      automaticExtractionEnabled: true,
      recallEnabled: true,
      crossChannelSharingEnabled: false,
      contactDeleteCommand: "删除我的记忆",
      ordinaryMessageDeletionObservable: true,
    });
    expect(first.text).toContain("当前代表与当前 Matrix 渠道");
    expect(first.text).toContain("不等于清除当前渠道的全部长期记忆");
    expect(telegram.fingerprint).not.toBe(first.fingerprint);
    expect(telegram.snapshot).toMatchObject({
      automaticExtractionEnabled: false,
      recallEnabled: false,
      ordinaryMessageDeletionObservable: false,
    });
    expect(telegram.text).toContain("Telegram Bot 无法收到普通消息删除事件");
    expect(telegram.text).toContain("/forget");
    expect(telegram.text).toContain("/delete_memory");
    expect(first.text).toContain("撤回或编辑普通聊天消息");
    expect(first.text).not.toContain("Telegram Bot 无法收到");
  });

  it("accurately discloses representative-experience-only extraction", () => {
    const descriptor = buildMemoryChannelDisclosureDescriptor({
      channel: "matrix",
      policy: {
        ...policy,
        contactMemoryEnabled: false,
        representativeExperienceEnabled: true,
      },
    });

    expect(descriptor.snapshot).toMatchObject({
      longTermMemoryEnabled: true,
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      automaticExtractionEnabled: true,
    });
    expect(descriptor.text).toContain("去标识化");
    expect(descriptor.text).not.toContain("可使用：当前联系人");
  });

  it("keeps raw and authority-bearing data outside long-term memory", () => {
    const descriptor = buildMemoryChannelDisclosureDescriptor({
      channel: "telegram",
      policy: { ...policy, telegramExtractEnabled: true },
    });

    for (const excluded of [
      "原始聊天全文",
      "私有备注",
      "Compute 原始产物",
      "凭据",
      "支付",
      "余额",
      "权益信息",
    ]) {
      expect(descriptor.text).toContain(excluded);
    }
    expect(descriptor.text).toContain("绝不会与其他联系人或代表共享");
    expect(descriptor.text).toContain("跨渠道共享保持关闭");
  });

  it("discloses explicit cross-channel consent and withdrawal commands", () => {
    const matrix = buildMemoryChannelDisclosureDescriptor({
      channel: "matrix",
      policy: { ...policy, contactMemoryCrossChannelEnabled: true },
    });
    const telegram = buildMemoryChannelDisclosureDescriptor({
      channel: "telegram",
      policy: {
        ...policy,
        contactMemoryCrossChannelEnabled: true,
        telegramRecallEnabled: true,
        telegramExtractEnabled: true,
      },
    });

    expect(matrix.snapshot).toMatchObject({
      crossChannelSharingEnabled: true,
      crossChannelDisclosureCommand: "!memory_share",
      crossChannelShareCommand: "!memory_share confirm <一次性令牌>",
      crossChannelUnshareCommand: "!memory_unshare",
    });
    expect(matrix.text).toContain("同一已验证身份");
    expect(matrix.text).toContain("!memory_share");
    expect(matrix.text).toContain("!memory_share confirm <一次性令牌>");
    expect(matrix.text).toContain("!memory_unshare");
    expect(matrix.text).toContain("立即停止全部跨渠道召回");
    expect(telegram.snapshot).toMatchObject({
      crossChannelSharingEnabled: true,
      crossChannelDisclosureCommand: "/memory_share",
      crossChannelShareCommand: "/memory_share confirm <一次性令牌>",
      crossChannelUnshareCommand: "/memory_unshare",
    });
    expect(telegram.text).toContain("/memory_share");
    expect(telegram.text).toContain("/memory_share confirm <一次性令牌>");
    expect(telegram.text).toContain("/memory_unshare");
  });

  it("authorizes only a later server-ordered message on the exact binding epoch", async () => {
    let hideDelivery = false;
    const deliveryFind = vi.fn(async () => hideDelivery ? null : ({
      deliveredAt: new Date("2026-08-06T10:00:00.000Z"),
      deliveredAfterIngressSequence: 10,
      externalMessageId: "$notice-1",
      proofHash: "a".repeat(64),
      connectionId: "matrix-connection-1",
      representativeAssignmentRevision: 9,
      evidenceKind: "MATRIX_MESSAGE",
      activation: {
        firstExcludedMessageId: "message-boundary",
        firstExcludedIngressSequence: 11,
        firstExcludedMessage: {
          conversationId: "conversation-1",
          channelBindingId: "binding-1",
          ingressSequence: 11,
        },
      },
    }));
    const messageFind = vi.fn(async () => ({
      id: "message-1",
      ingressSequence: 12,
      externalMessageId: "provider-message-12",
      channelBindingId: "binding-1",
      channelBinding: {
        id: "binding-1",
        kind: "MATRIX",
        connectionId: "matrix-connection-1",
        representativeAssignmentRevision: 9,
      },
    }));
    const tx = {
      message: { findFirst: messageFind },
      representativeMemoryPolicy: { findUnique: vi.fn(async () => policy) },
      memoryChannelDisclosureDelivery: { findFirst: deliveryFind },
    } as unknown as Prisma.TransactionClient;

    await expect(hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "matrix",
      capability: "recall",
    })).resolves.toBe(true);
    expect(deliveryFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channelBindingId: "binding-1",
        bindingEpoch: expect.stringMatching(/^[0-9a-f]{64}$/u),
        excludedInboundMessages: {
          none: { externalInboundMessageId: "provider-message-12" },
        },
      }),
    }));

    messageFind.mockResolvedValueOnce({
      id: "message-boundary",
      ingressSequence: 11,
      externalMessageId: "provider-message-11",
      channelBindingId: "binding-1",
      channelBinding: {
        id: "binding-1",
        kind: "MATRIX",
        connectionId: "matrix-connection-1",
        representativeAssignmentRevision: 9,
      },
    });
    await expect(hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-boundary",
      channel: "matrix",
      capability: "recall",
    })).resolves.toBe(false);

    messageFind.mockResolvedValueOnce({
      id: "message-excluded",
      ingressSequence: 13,
      externalMessageId: "provider-message-excluded",
      channelBindingId: "binding-1",
      channelBinding: {
        id: "binding-1",
        kind: "MATRIX",
        connectionId: "matrix-connection-1",
        representativeAssignmentRevision: 9,
      },
    });
    hideDelivery = true;
    await expect(hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-excluded",
      channel: "matrix",
      capability: "recall",
    })).resolves.toBe(false);
    hideDelivery = false;

    deliveryFind.mockResolvedValueOnce({
      deliveredAt: new Date("2026-08-06T10:00:00.000Z"),
      deliveredAfterIngressSequence: 10,
      externalMessageId: "$notice-old-epoch",
      proofHash: "b".repeat(64),
      connectionId: "matrix-connection-old",
      representativeAssignmentRevision: 8,
      evidenceKind: "MATRIX_MESSAGE",
      activation: {
        firstExcludedMessageId: "message-boundary",
        firstExcludedIngressSequence: 11,
        firstExcludedMessage: {
          conversationId: "conversation-1",
          channelBindingId: "binding-1",
          ingressSequence: 11,
        },
      },
    });
    await expect(hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "matrix",
      capability: "recall",
    })).resolves.toBe(false);
  });

  it("records the earliest post-delivery message as the immutable exclusion boundary", async () => {
    const messageFind = vi.fn()
      .mockResolvedValueOnce({
        id: "message-12",
        ingressSequence: 12,
        channelBindingId: "binding-1",
        channelBinding: {
          id: "binding-1",
          kind: "MATRIX",
          connectionId: "matrix-connection-1",
          representativeAssignmentRevision: 9,
        },
      })
      .mockResolvedValueOnce({ id: "message-11", ingressSequence: 11 });
    const createMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      message: { findFirst: messageFind },
      representativeMemoryPolicy: { findUnique: vi.fn(async () => policy) },
      memoryChannelDisclosureDelivery: {
        findFirst: vi.fn(async () => ({
          id: "delivery-1",
          deliveredAfterIngressSequence: 10,
          connectionId: "matrix-connection-1",
          representativeAssignmentRevision: 9,
          evidenceKind: "MATRIX_MESSAGE",
          proofHash: "a".repeat(64),
          activation: null,
        })),
      },
      memoryChannelDisclosureActivation: { createMany },
    } as unknown as Prisma.TransactionClient;

    await expect(activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-12",
      channel: "matrix",
    })).resolves.toBe(true);
    expect(createMany).toHaveBeenCalledWith({
      data: [{
        deliveryId: "delivery-1",
        firstExcludedMessageId: "message-11",
        firstExcludedIngressSequence: 11,
      }],
      skipDuplicates: true,
    });
  });
});
