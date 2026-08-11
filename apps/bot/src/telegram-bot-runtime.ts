import "dotenv/config";

import { demoRepresentative } from "@delegate/domain";
import { generateRepresentativeReply } from "@delegate/model-runtime";
import { Channel } from "@prisma/client";
import {
  advanceStructuredCollector,
  beginStructuredCollector,
  createConversationPlan,
  formatComputeUsageExamples,
  formatStructuredCollectorPrompt,
  formatStructuredCollectorSummary,
  renderReplyPreview,
  parseComputeRequest,
  resolveCollectorSubagent,
  resolveComputeSubagent,
  resolveConversationSubagent,
  resolveTelegramGroupHandling,
  shouldStartStructuredCollector,
  type ConversationPlan,
  type StructuredCollectorState,
} from "@delegate/runtime";
import {
  acceptInboundConversationMessage,
  assertConversationChannelDeliveryAvailable,
  ChannelUnavailableError,
  contactMemorySharingConsentContractVersion,
  consumeIdentityBindingChallenge,
  createAudienceComputeSession,
  createContactMemorySharingChallenge,
  DelegationMessageEditConflictError,
  editConversationMessage,
  executeAudienceTool,
  grantContactMemorySharingConsent,
  privateChannelIdentityProviders,
  readContactMemorySharingChallengeToken,
  revokeContactMemorySharingConsent,
} from "@delegate/web-data";
import { Bot, InlineKeyboard } from "grammy";

import { botLifecycleHooks } from "./lifecycle-hooks";
import {
  resolveTelegramConversationPlatformMode,
  shouldFailClosedAfterConversationPlatformWrite,
} from "./conversation-platform-mode";
import {
  buildRepresentativeWebRechargeUrl,
  buildTelegramBotCommands,
  buildWebRechargeMessage,
  resolveTelegramInlineKeyboardUrl,
} from "./commerce-ux";
import {
  buildHandoffPreparation,
  clearStructuredCollectorState,
  findTelegramInboundMessageEditTarget,
  getActiveRepresentativeSlugForChat,
  getConversationContext,
  getDefaultRepresentativeSlugForTelegramBot,
  getRecentConversationTurns,
  maybeCreateHandoffRequest,
  persistAndProcessTelegramSuccessfulPayment,
  recordModelUsage,
  recordComputeInboundTurn,
  recordComputeReply,
  recordInboundTurn,
  recordOutboundReply,
  setActiveComputeSession,
  setActiveRepresentativeForChat,
  setStructuredCollectorState,
  submitStructuredCollector,
  synchronizeTelegramBotChannelBindings,
  retryPendingTelegramSuccessfulPayments,
  updateStructuredCollectorState,
  validatePendingInvoice,
} from "./runtime-store";
import { prisma } from "./prisma";
import { getRepresentativeRuntimeConfig } from "./representative-config";
import {
  recallOpenVikingContext,
} from "./openviking-runtime";
import {
  buildTelegramUpdateMetadata,
  handleTelegramMiddlewareError,
  logTelegramUpdateExecution,
  normalizeTelegramCommandEntity,
  resolveTelegramRepresentativeSession,
  resolveTelegramRuntimeConfig,
  sanitizeTelegramError,
} from "./telegram-runtime";
import {
  requireTelegramRuntimeContext,
  runWithTelegramRuntimeContext,
  type TelegramRuntimeContext,
} from "./telegram-runtime-context";
import {
  ensureTelegramMemoryDisclosure,
  resolveTelegramProviderOccurredAt,
  telegramContactMemoryDeleteText,
} from "./telegram-memory";
import {
  lockTelegramMessageEditLease,
  persistAndProcessTelegramMessageEdit,
  retryPendingTelegramMessageEdits,
  TelegramMessageEditLeaseLostError,
  TelegramMessageEditNotDurableError,
  TelegramMessageEditRetryableError,
  TelegramMessageEditTerminalError,
  type TelegramMessageEditEvent,
  type TelegramMessageEditLease,
} from "./telegram-message-edit-inbox";

export type TelegramBotRuntimeConfig = {
  internalConnectionId: string;
  botId: string;
  username?: string | null;
  displayName?: string | null;
  token: string;
  credentialRevision: number;
  legacy?: boolean;
};

export type TelegramBotRuntime = {
  config: TelegramBotRuntimeConfig;
  username?: string;
  start: () => Promise<void>;
  stop: (signal: "SIGINT" | "SIGTERM" | "SUPERVISOR") => Promise<void>;
};

export async function createTelegramBotRuntime(
  config: TelegramBotRuntimeConfig,
): Promise<TelegramBotRuntime> {
const conversationPlatformMode = resolveTelegramConversationPlatformMode();
const telegramRuntimeConfig = resolveTelegramRuntimeConfig();
const bot = new Bot(config.token, {
  client: {
    timeoutSeconds: telegramRuntimeConfig.apiTimeoutSeconds,
  },
});
const me = await initializeTelegramBot();
const runtimeContext: TelegramRuntimeContext = {
  internalConnectionId: config.internalConnectionId,
  botId: String(me.id),
  ...(me.username ? { username: me.username } : {}),
};

void runWithTelegramRuntimeContext(
  runtimeContext,
  () => retryPendingTelegramSuccessfulPayments(),
).catch((error) => {
  console.error("Telegram payment reconciliation startup pass failed:", error);
});
const telegramPaymentRetryTimer = setInterval(() => {
  void runWithTelegramRuntimeContext(
    runtimeContext,
    () => retryPendingTelegramSuccessfulPayments(),
  ).catch((error) => {
    console.error("Telegram payment reconciliation pass failed:", error);
  });
}, 5_000);
telegramPaymentRetryTimer.unref();
void runWithTelegramRuntimeContext(
  runtimeContext,
  () => retryPendingTelegramMessageEdits(applyTelegramMessageEdit),
).catch((error) => {
  console.error("Telegram message edit reconciliation startup pass failed:", error);
});
const telegramMessageEditRetryTimer = setInterval(() => {
  void runWithTelegramRuntimeContext(
    runtimeContext,
    () => retryPendingTelegramMessageEdits(applyTelegramMessageEdit),
  ).catch((error) => {
    console.error("Telegram message edit reconciliation pass failed:", error);
  });
}, 5_000);
telegramMessageEditRetryTimer.unref();
const pendingTelegramMessageEditDurability = new Set<Promise<unknown>>();
let telegramMessageEditDurabilityFailure: unknown = null;

function trackTelegramMessageEditDurability<T>(promise: Promise<T>): Promise<T> {
  pendingTelegramMessageEditDurability.add(promise);
  void promise.then(
    () => pendingTelegramMessageEditDurability.delete(promise),
    (error) => {
      telegramMessageEditDurabilityFailure = error;
      pendingTelegramMessageEditDurability.delete(promise);
    },
  );
  return promise;
}

async function waitForTelegramMessageEditDurabilityFence() {
  // grammY records lastTriedUpdateId before awaiting middleware. Drain every
  // edit persistence promise before bot.stop() confirms that offset. Recheck
  // after a microtask so the sequential update loop can admit its next edit.
  while (true) {
    const pending = [...pendingTelegramMessageEditDurability];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      continue;
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (pendingTelegramMessageEditDurability.size === 0) {
      if (telegramMessageEditDurabilityFailure) {
        throw new TelegramMessageEditNotDurableError(
          telegramMessageEditDurabilityFailure,
        );
      }
      return;
    }
  }
}

bot.use((_ctx, next) =>
  runWithTelegramRuntimeContext(runtimeContext, next),
);
bot.use(async (ctx, next) => {
  const synthesizedCommandEntity = normalizeTelegramCommandEntity(
    ctx.message,
  );
  await logTelegramUpdateExecution(
    buildTelegramUpdateMetadata(ctx.update, synthesizedCommandEntity),
    next,
  );
});

bot.command("start", async (ctx) => {
  if (!ctx.from) {
    await ctx.reply("当前无法识别你的 Telegram 身份，请稍后重试。");
    return;
  }

  const payload = ctx.match?.trim();
  const assignedDefaultRepresentativeSlug =
    await getDefaultRepresentativeSlugForTelegramBot();
  if (!payload && !assignedDefaultRepresentativeSlug) {
    await ctx.reply(
      "这个 Bot 连接了多个数字代表。请从目标代表的公开页面重新打开 Telegram，以避免消息进入错误代表。",
    );
    return;
  }
  const defaultRepresentativeSlug =
    assignedDefaultRepresentativeSlug
    || process.env.DEMO_REP_SLUG
    || demoRepresentative.slug;
  const startPayload = parseStartPayload(payload, defaultRepresentativeSlug);
  let activeRepresentativeSlug = startPayload.representativeSlug;

  if (ctx.chat.type === "private") {
    try {
      activeRepresentativeSlug = await setActiveRepresentativeForChat({
        telegramChatId: ctx.chat.id,
        telegramUserId: ctx.from.id,
        representativeSlug: startPayload.representativeSlug,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_representative_switch_failed",
          updateId: ctx.update.update_id,
          error: sanitizeTelegramError(error),
        }),
      );
      await ctx.reply(
        "当前无法切换数字代表。为避免消息进入错误代表，原会话保持不变，请稍后重试。",
      );
      return;
    }
  }

  const representative = await getRepresentativeRuntimeConfig(activeRepresentativeSlug);

  if (ctx.chat.type === "private") {
    try {
      const conversationContext = await getConversationContext(
        activeRepresentativeSlug,
        {
          telegramUserId: ctx.from.id,
          ...(ctx.from.username ? { username: ctx.from.username } : {}),
          ...buildDisplayName(ctx.from.first_name, ctx.from.last_name),
          chatId: ctx.chat.id,
          channel: Channel.PRIVATE_CHAT,
        },
      );
      await assertConversationChannelDeliveryAvailable({
        conversationId: conversationContext.conversationId,
        channel: "telegram",
      });
      await deliverTelegramMemoryDisclosure(
        ctx,
        conversationContext.conversationId,
        String(ctx.message?.message_id ?? `update:${ctx.update.update_id}`),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_memory_disclosure_start_failed",
          updateId: ctx.update.update_id,
          error: sanitizeTelegramError(error),
        }),
      );
      await ctx.reply(
        "记忆说明暂时无法安全确认，本轮不会启用 Telegram 长期记忆；你仍可继续基础对话。",
      );
    }
  }

  const payloadNote =
    payload && activeRepresentativeSlug !== defaultRepresentativeSlug
      ? `当前正在和 ${representative.name} 对话。这个会话会继续沿用该代表的公开知识与收费规则。`
      : "你进入的是默认 Founder Representative 演示入口。";
  const plansKeyboard = buildPlansKeyboard(representative.slug);

  await ctx.reply(
    [
      representative.name,
      representative.tagline,
      payloadNote,
      `免费规则：前 ${representative.contract.freeReplyLimit} 条回复适合基础问答与资料领取。`,
      "我可以回答 FAQ、发资料、收集合作与报价信息，并在必要时发起人工转接。",
      "需要继续服务时，可用 /plans 查看当前方案并前往 Web 充值。",
    ].join("\n\n"),
    plansKeyboard ? { reply_markup: plansKeyboard } : {},
  );
});

bot.command("plans", async (ctx) => {
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  const representative = await getRepresentativeRuntimeConfig(representativeSlug);
  await sendPlansMessage(ctx, representative);
});

bot.command("buy", async (ctx) => {
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  await sendWebRechargeEntry(ctx, representativeSlug);
});

bot.command("paysupport", async (ctx) => {
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  const representative = await getRepresentativeRuntimeConfig(
    representativeSlug,
  );
  const rechargeUrl = buildRepresentativeWebRechargeUrl(
    representative.slug,
  );
  const rechargeKeyboard = buildWebRechargeKeyboard(
    "打开 Web 充值",
    rechargeUrl,
  );
  await ctx.reply(
    [
      "当前新充值与付费统一在 Web 完成；订单或退款问题请通过代表页面联系所有者。",
      "如果你有历史 Telegram 付款，请说明发票或付款背景，以便人工核对。",
      rechargeUrl ? `Web 充值入口：${rechargeUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    rechargeKeyboard
      ? { reply_markup: rechargeKeyboard }
      : {},
  );
});

bot.command("bind", async (ctx) => {
  if (ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("账户绑定只能在 bot 私聊中完成。");
    return;
  }
  const bindingToken = ctx.match?.trim();
  if (!bindingToken) {
    await ctx.reply("请先在 Web 登录并生成绑定命令，然后发送：/bind <一次性代码>");
    return;
  }

  let binding:
    | Awaited<ReturnType<typeof consumeIdentityBindingChallenge>>
    | undefined;
  try {
    binding = await consumeIdentityBindingChallenge({
      token: bindingToken,
      provider: privateChannelIdentityProviders.telegram,
      providerSubject: String(ctx.from.id),
      issuer: "delegate-managed-bot",
      connectionId: String(me.id),
      proofMetadata: {
        chatType: ctx.chat.type,
        telegramChatId: String(ctx.chat.id),
      },
    });
  } catch (error) {
    await ctx.reply(
      error instanceof Error
        ? `绑定失败：${error.message}`
        : "绑定失败，请回到 Web 重新生成一次性代码。",
    );
    return;
  }

  const representativeSlug =
    readRepresentativeSlugFromIdentityBinding(binding);
  if (representativeSlug) {
    try {
      const activeRepresentativeSlug =
        await setActiveRepresentativeForChat({
          telegramChatId: ctx.chat.id,
          telegramUserId: ctx.from.id,
          representativeSlug,
        });
      const representative = await getRepresentativeRuntimeConfig(
        activeRepresentativeSlug,
      );
      await ctx.reply(
        `绑定成功。你的 Telegram 会话现在已对应到同一个 Delegate 用户与服务权益，当前正在与 ${representative.name} 对话。`,
      );
      return;
    } catch {
      await ctx.reply(
        "账号绑定已经完成，但这个数字代表的 Bot 配置刚刚发生了变化，未切换当前会话。请回到代表公开页刷新后重新选择。",
      );
      return;
    }
  }
  await ctx.reply(
    "绑定成功。你的 Telegram 会话现在已对应到同一个 Delegate 用户与服务权益；请从代表公开页重新打开 Bot 以选择当前代表。",
  );
});

bot.command("memory_share", async (ctx) => {
  if (ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("跨渠道联系人记忆只能在 Bot 私聊中授权。");
    return;
  }
  const commandArguments = ctx.match?.trim().replace(/\s+/gu, " ") ?? "";
  const challengeToken = commandArguments
    ? readContactMemorySharingChallengeToken(commandArguments)
    : null;
  if (commandArguments && !challengeToken) {
    await ctx.reply(
      "一次性确认令牌缺失或无效。请重新发送 /memory_share 阅读说明并获取新令牌；裸 /memory_share confirm 不会授权。",
    );
    return;
  }
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  try {
    const conversationContext = await getConversationContext(
      representativeSlug,
      {
        telegramUserId: ctx.from.id,
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        ...buildDisplayName(ctx.from.first_name, ctx.from.last_name),
        chatId: ctx.chat.id,
        channel: Channel.PRIVATE_CHAT,
      },
    );
    const sourceEvidence = {
      sourceChannel: "TELEGRAM",
      providerSubject: String(ctx.from.id),
      issuer: "delegate-managed-bot",
      connectionId: String(me.id),
    } as const;
    const sourceEventKey = [
      "telegram",
      me.id,
      ctx.chat.id,
      ctx.from.id,
      ctx.update.update_id,
      ctx.message?.message_id ?? "missing-message-id",
    ].join(":");
    if (!challengeToken) {
      const challenge = await createContactMemorySharingChallenge({
        representativeSlug,
        audienceIdentityId: conversationContext.audienceIdentityId,
        disclosureContractVersion:
          contactMemorySharingConsentContractVersion,
        sourceEventKey,
        ...sourceEvidence,
      });
      await ctx.reply(
        [
          "跨渠道联系人记忆只会共享给当前数字代表，并且只在已验证为同一 Delegate 用户的 Web、Matrix、Telegram 私聊之间使用。",
          "系统不会把原始聊天、付款或余额、凭据、Owner 私有备注、Compute 原始产物写入长期记忆；每次召回仍会检查当前身份、策略和渠道授权。",
          "你可以随时发送 /memory_unshare，立即停止共享记忆召回并异步清理远端投影；各渠道原始会话和渠道内记忆不受影响。",
          `如果你同意，请在 10 分钟内发送：/memory_share confirm ${challenge.challengeToken}`,
        ].join("\n\n"),
      );
      return;
    }
    const result = await grantContactMemorySharingConsent({
      representativeSlug,
      audienceIdentityId: conversationContext.audienceIdentityId,
      challengeToken,
      sourceEventKey,
      ...sourceEvidence,
    });
    await ctx.reply(
      result.active
        ? "已允许当前数字代表在已验证为同一 Delegate 用户的 Web、Matrix 和 Telegram 私聊之间使用联系人记忆。"
        : "跨渠道联系人记忆状态刚刚发生变化，请重新发送 /memory_share。",
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: challengeToken
          ? "telegram_contact_memory_sharing_grant_failed"
          : "telegram_contact_memory_sharing_disclosure_failed",
        updateId: ctx.update.update_id,
        error: sanitizeTelegramError(error),
      }),
    );
    await ctx.reply(
      challengeToken
        ? "一次性确认令牌无效、已过期或已使用。请重新发送 /memory_share 获取新令牌。"
        : "暂时无法提供跨渠道联系人记忆授权说明。请确认已从当前代表的 Web 页面登录并绑定这个 Telegram 账号，且 Owner 已开启该策略。",
    );
  }
});

bot.command("memory_unshare", async (ctx) => {
  if (ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("跨渠道联系人记忆只能在 Bot 私聊中撤回。");
    return;
  }
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  try {
    const conversationContext = await getConversationContext(
      representativeSlug,
      {
        telegramUserId: ctx.from.id,
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        ...buildDisplayName(ctx.from.first_name, ctx.from.last_name),
        chatId: ctx.chat.id,
        channel: Channel.PRIVATE_CHAT,
      },
    );
    const result = await revokeContactMemorySharingConsent({
      representativeSlug,
      audienceIdentityId: conversationContext.audienceIdentityId,
      sourceChannel: "TELEGRAM",
    });
    await ctx.reply(
      result.changed
        ? "已立即停止当前数字代表的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
        : "当前没有有效的跨渠道联系人记忆授权；系统已再次确认共享召回处于关闭状态。",
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "telegram_contact_memory_sharing_revoke_failed",
        updateId: ctx.update.update_id,
        error: sanitizeTelegramError(error),
      }),
    );
    await ctx.reply("当前无法安全撤回跨渠道联系人记忆，请稍后重试或在 Web 代表页面操作。");
  }
});

const handleContactMemoryDeleteCommand = async (ctx: any) => {
  if (ctx.chat?.type !== "private" || !ctx.from || !ctx.message) {
    await ctx.reply("联系人记忆只能在 Bot 私聊中删除。");
    return;
  }
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  try {
    const conversationContext = await getConversationContext(
      representativeSlug,
      {
        telegramUserId: ctx.from.id,
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        ...buildDisplayName(ctx.from.first_name, ctx.from.last_name),
        chatId: ctx.chat.id,
        channel: Channel.PRIVATE_CHAT,
      },
    );
    await assertConversationChannelDeliveryAvailable({
      conversationId: conversationContext.conversationId,
      channel: "telegram",
    });
    const deletionInput = {
      representativeSlug,
      conversationId: conversationContext.conversationId,
      text: telegramContactMemoryDeleteText,
      senderId: String(ctx.from.id),
      senderDisplayName:
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
        || ctx.from.username
        || String(ctx.from.id),
      clientMessageId:
        `telegram:${me.id}:${ctx.chat.id}:${ctx.message.message_id}`,
      channel: "telegram",
      externalMessageId: String(ctx.message.message_id),
      queueGeneration: false,
      occurredAt: resolveTelegramProviderOccurredAt(ctx.message.date),
    } satisfies Parameters<typeof acceptInboundConversationMessage>[0] & {
      occurredAt: Date;
    };
    await acceptInboundConversationMessage(deletionInput);
    await ctx.reply(
      "已立即停止召回当前数字代表与当前 Telegram 渠道下的联系人记忆；物理清理已进入可重试队列。代表经验和其他渠道不受影响。",
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "telegram_contact_memory_delete_failed",
        updateId: ctx.update.update_id,
        error: sanitizeTelegramError(error),
      }),
    );
    await ctx.reply("当前无法安全删除联系人记忆，请稍后重试。");
  }
};

bot.command("forget", handleContactMemoryDeleteCommand);
bot.command("delete_memory", handleContactMemoryDeleteCommand);

bot.command("compute", async (ctx) => {
  if (ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("Compute 请求目前只在 bot 私聊里开放。");
    return;
  }
  if (conversationPlatformMode === "worker") {
    await ctx.reply(
      "Telegram 统一会话暂未开放直接 Compute；请从 Web 发起受控计算任务。",
    );
    return;
  }

  const parsed = parseComputeRequest(`/compute ${ctx.match?.trim() ?? ""}`);
  if (!parsed) {
    await ctx.reply(
      [
        "用法示例：",
        formatComputeUsageExamples(),
      ].join("\n"),
    );
    return;
  }

  const representativeSlug = await resolveRepresentativeSlugForChat(ctx.chat.type, ctx.chat.id);
  await handleComputeRequest({
    ctx,
    representativeSlug,
    parsed,
    rawText: `/compute ${ctx.match?.trim() ?? ""}`.trim(),
  });
});

bot.callbackQuery("plans:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat?.type ?? "private",
    ctx.chat?.id ?? ctx.from.id,
  );
  const representative = await getRepresentativeRuntimeConfig(representativeSlug);
  await sendPlansMessage(ctx, representative);
});

bot.on("pre_checkout_query", async (ctx) => {
  try {
    await validatePendingInvoice(
      ctx.preCheckoutQuery.invoice_payload,
      ctx.preCheckoutQuery.from.id,
      {
        currency: ctx.preCheckoutQuery.currency,
        totalAmount: ctx.preCheckoutQuery.total_amount,
      },
    );
    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    await ctx.answerPreCheckoutQuery(
      false,
      error instanceof Error ? error.message : "This invoice is no longer available.",
    );
  }
});

bot.on("message:successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  let paymentSafelyPersisted = false;

  try {
    const paymentResult = await persistAndProcessTelegramSuccessfulPayment({
      invoicePayload: payment.invoice_payload,
      totalAmount: payment.total_amount,
      currency: payment.currency,
      telegramUserId: ctx.from.id,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      ...(payment.provider_payment_charge_id
        ? { providerPaymentChargeId: payment.provider_payment_charge_id }
        : {}),
    });
    paymentSafelyPersisted = true;
    if (paymentResult.status === "retrying") {
      await ctx.reply(
        "付款事件已安全记录，权益正在自动确认；如长时间未到账，请发送 /paysupport。",
      );
      return;
    }
    const confirmed = paymentResult.confirmation;

    const replyText = [
      `已确认 ${confirmed.planName} 付款，收到 ${confirmed.starsAmount} Stars。`,
      "你的会话深度已经解锁；如果需要我继续做需求采集、报价梳理或升级转人工，直接继续发消息就可以。",
    ].join("\n\n");

    await ctx.reply(replyText);

  } catch (error) {
    if (paymentSafelyPersisted) {
      console.error("Telegram payment post-confirmation side effect failed:", error);
      return;
    }
    try {
      await ctx.reply(
        "付款事件暂时无法安全入库，请不要重复支付，并发送 /paysupport。",
      );
    } finally {
      throw error instanceof Error
        ? error
        : new Error("Telegram payment persistence failed.");
    }
  }
});

bot.on("edited_message:text", async (ctx) => {
  const editedMessage = ctx.editedMessage;
  if (
    ctx.chat.type !== "private"
    || !ctx.from
    || !editedMessage.text.trim()
  ) return;

  let editedAt: string;
  try {
    editedAt = resolveTelegramProviderOccurredAt(
      editedMessage.edit_date ?? editedMessage.date,
    ).toISOString();
  } catch (error) {
    // Nothing has been durably recorded yet. Escalating this error stops the
    // current long-poll cycle so Telegram does not confirm the update offset.
    throw new TelegramMessageEditNotDurableError(error);
  }

  const result = await trackTelegramMessageEditDurability(
    persistAndProcessTelegramMessageEdit(
      {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from.id,
        chatId: String(ctx.chat.id),
        externalMessageId: String(editedMessage.message_id),
        text: editedMessage.text,
        editedAt,
      },
      applyTelegramMessageEdit,
    ),
  );
  if (result.status === "retrying") {
    console.warn(
      JSON.stringify({
        event: "telegram_message_edit_retry_scheduled",
        updateId: ctx.update.update_id,
        externalMessageId: String(editedMessage.message_id),
      }),
    );
  }
});

bot.on("message:text", async (ctx) => {
  const rawText = ctx.message.text.trim();

  if (rawText.startsWith("/")) {
    return;
  }

  const isPrivate = ctx.chat.type === "private";
  const isReplyToBot = ctx.message.reply_to_message?.from?.id === me.id;
  const mentionsBot =
    typeof me.username === "string" &&
    rawText.toLowerCase().includes(`@${me.username.toLowerCase()}`);
  const representativeSlug = await resolveRepresentativeSlugForChat(
    ctx.chat.type,
    ctx.chat.id,
  );
  const representative = await getRepresentativeRuntimeConfig(representativeSlug);

  const groupHandling = resolveTelegramGroupHandling({
    chatType: ctx.chat.type,
    activation: representative.groupActivation,
    wasMentioned: mentionsBot,
    isReplyToRepresentative: isReplyToBot,
  });

  if (!groupHandling.shouldHandle) {
    return;
  }

  const text = stripBotMention(rawText, me.username);
  const channel = mapMessageToChannel(ctx.chat.type, isReplyToBot);
  const runtimeChannel =
    isPrivate ? "private_chat" : isReplyToBot ? "group_reply" : "group_mention";
  const normalizedText = text.length > 0 ? text : rawText;
  const inlineComputeRequest = isPrivate ? parseComputeRequest(normalizedText) : null;

  let conversationContext:
    | Awaited<ReturnType<typeof getConversationContext>>
    | null = null;

  try {
    conversationContext = await getConversationContext(representativeSlug, {
      telegramUserId: ctx.from.id,
      ...(ctx.from.username ? { username: ctx.from.username } : {}),
      ...buildDisplayName(ctx.from.first_name, ctx.from.last_name),
      chatId: ctx.chat.id,
      channel,
    });
  } catch (error) {
    console.warn("Bot persistence unavailable:", error);
  }

  if (!conversationContext) {
    await ctx.reply("当前渠道状态暂时无法确认，请稍后再试。");
    return;
  }

  try {
    await assertConversationChannelDeliveryAvailable({
      conversationId: conversationContext.conversationId,
      channel: "telegram",
    });
  } catch (error) {
    console.warn("Telegram channel availability check failed:", error);
    await ctx.reply("当前渠道已暂停或暂时不可用，请稍后再试。");
    return;
  }

  if (conversationPlatformMode === "worker" && !isPrivate) {
    await ctx.reply("当前统一会话版本仅支持 Telegram 私聊，请在私聊中继续。");
    return;
  }

  if (isPrivate) {
    try {
      await deliverTelegramMemoryDisclosure(
        ctx,
        conversationContext.conversationId,
        String(ctx.message.message_id),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_memory_disclosure_message_failed",
          updateId: ctx.update.update_id,
          error: sanitizeTelegramError(error),
        }),
      );
    }
  }

  if (
    isPrivate
    && conversationContext
    && (conversationPlatformMode === "worker" || conversationPlatformMode === "shadow")
  ) {
    try {
      const inboundInput = {
        representativeSlug,
        conversationId: conversationContext.conversationId,
        text: normalizedText,
        senderId: String(ctx.from.id),
        senderDisplayName:
          [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
          || ctx.from.username
          || String(ctx.from.id),
        clientMessageId:
          `telegram:${me.id}:${ctx.chat.id}:${ctx.message.message_id}`,
        channel: "telegram",
        externalMessageId: String(ctx.message.message_id),
        queueGeneration: conversationPlatformMode === "worker",
        occurredAt: resolveTelegramProviderOccurredAt(ctx.message.date),
      } satisfies Parameters<typeof acceptInboundConversationMessage>[0] & {
        occurredAt: Date;
      };
      await acceptInboundConversationMessage(inboundInput);
      if (conversationPlatformMode === "worker") {
        return;
      }
    } catch (error) {
      if (shouldFailClosedAfterConversationPlatformWrite(conversationPlatformMode, error)) {
        await ctx.reply(
          error instanceof Error
            ? error instanceof ChannelUnavailableError
              ? "当前渠道已暂停或暂时不可用，请稍后再试。"
              : error.message
            : "当前渠道暂时不可用，请稍后再试。",
        );
        return;
      }
      console.warn("Telegram conversation shadow-write failed:", error);
    }
  }

  const plan = createConversationPlan({
    text: normalizedText,
    channel: runtimeChannel,
    representative,
    usage:
      conversationContext?.usage ?? {
        freeRepliesUsed: 0,
        passUnlocked: false,
        deepHelpUnlocked: false,
      },
  });
  const planSubagent = resolveConversationSubagent(plan);

  const recalled = conversationContext
    ? await recallOpenVikingContext({
        context: conversationContext,
        queryText: normalizedText,
      })
    : [];

  if (inlineComputeRequest && conversationContext) {
    await handleComputeRequest({
      ctx,
      representativeSlug,
      parsed: inlineComputeRequest,
      rawText: normalizedText,
      representative,
      conversationContext,
    });
    return;
  }

  if (conversationContext?.collectorState) {
    const collectorPlan = buildCollectorConversationPlan(conversationContext.collectorState);
    const collectorSubagent = resolveCollectorSubagent(conversationContext.collectorState);

    await recordInboundTurn({
      context: conversationContext,
      plan: collectorPlan,
      text: normalizedText,
      subagentId: collectorSubagent.id,
    });

    if (isCollectorCancelMessage(normalizedText)) {
      await clearStructuredCollectorState(conversationContext);

      const replyText = [
        representative.name,
        representative.tagline,
        "已停止当前结构化采集。你可以重新描述需求，我会判断是继续 FAQ、重新开始报价采集，还是转人工。",
      ]
        .filter(Boolean)
        .join("\n\n");

      await ctx.reply(replyText);
      await recordOutboundReply({
        context: conversationContext,
        plan: collectorPlan,
        messageText: replyText,
        subagentId: collectorSubagent.id,
      });
      return;
    }

    const advanced = advanceStructuredCollector(
      conversationContext.collectorState,
      normalizedText,
    );

    if (!advanced.state) {
      await clearStructuredCollectorState(conversationContext);
      await ctx.reply("当前 intake 状态不可恢复，我已经先结束这轮采集。请重新描述你的需求。");
      return;
    }

    if (!advanced.completed) {
      await updateStructuredCollectorState({
        context: conversationContext,
        collectorState: advanced.state,
      });

      const replyText = [
        representative.name,
        representative.tagline,
        formatStructuredCollectorPrompt(advanced.state),
      ]
        .filter(Boolean)
        .join("\n\n");

      await ctx.reply(
        replyText,
        buildPlanReplyOptions(collectorPlan, representative.slug),
      );
      await recordOutboundReply({
        context: conversationContext,
        plan: collectorPlan,
        messageText: replyText,
        subagentId: collectorSubagent.id,
      });
      return;
    }

    const submitted = await submitStructuredCollector({
      context: conversationContext,
      collectorState: advanced.state,
    });

    const completionNote =
      advanced.state.kind === "scheduling"
        ? "预约意向已经整理完成。"
        : "报价 / 合作背景已经整理完成。";
    const paidFollowup = submitted.handoffId
      ? !conversationContext.contactIsPaid && advanced.state.suggestedPlan
        ? `如果你希望我继续保留更长上下文并优先推进，请前往 ${representative.name} 的 Web 页面查看当前方案并充值。`
        : "接下来主人会基于这份结构化摘要判断是否亲自接手。"
      : null;
    const handoffStatusNote = submitted.handoffId
      ? `已创建 owner inbox 收件项：${submitted.handoffId}`
      : submitted.handoffOutcome === "entitlement_required"
        ? "结构化摘要已保存；当前没有可用的人工转接权益，请先购买包含人工转接的服务套餐。"
        : submitted.handoffOutcome === "handoff_disabled"
          ? "结构化摘要已保存；该数字代表当前未启用人工转接。"
          : submitted.handoffOutcome === "active_request_exists"
            ? "结构化摘要已保存；你已有一条进行中的人工转接请求，本次未重复创建。"
            : "结构化摘要已保存，但本次未创建人工转接请求。";
    const replyText = [
      representative.name,
      representative.tagline,
      completionNote,
      formatStructuredCollectorSummary(advanced.state),
      handoffStatusNote,
      submitted.recommendedOwnerAction,
      paidFollowup,
    ]
      .filter(Boolean)
      .join("\n\n");

    await ctx.reply(
      replyText,
      buildPlanReplyOptions(collectorPlan, representative.slug),
    );
    await recordOutboundReply({
      context: conversationContext,
      plan: collectorPlan,
      messageText: replyText,
      subagentId: collectorSubagent.id,
    });
    return;
  }

  if (conversationContext) {
    await recordInboundTurn({
      context: conversationContext,
      plan,
      text: normalizedText,
      subagentId: planSubagent.id,
    });
  }

  if (conversationContext && shouldStartStructuredCollector(plan)) {
    const collector = beginStructuredCollector({
      plan,
      channel: runtimeChannel,
    });

    await setStructuredCollectorState({
      context: conversationContext,
      collectorState: collector,
    });

    const replyText = [
      representative.name,
      representative.tagline,
      formatStructuredCollectorPrompt(collector),
      "如果你想中途结束，直接发送 取消 即可。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const replyMarkup = buildPlanKeyboardForConversation(
      plan,
      representative.slug,
    );
    await ctx.reply(replyText, replyMarkup ? { reply_markup: replyMarkup } : {});

    await recordOutboundReply({
      context: conversationContext,
      plan,
      messageText: replyText,
      subagentId: planSubagent.id,
    });
    return;
  }

  const handoff = conversationContext
    ? await (async () => {
        const prepared =
          plan.nextStep === "handoff" || plan.nextStep === "ask_owner"
            ? buildHandoffPreparation({
                plan,
                text: normalizedText,
              })
            : null;

        if (prepared) {
          await botLifecycleHooks.emit({
            kind: "handoff_prepared",
            scope: {
              representativeId: conversationContext.representativeId,
              representativeSlug: conversationContext.representativeSlug,
              contactId: conversationContext.contactId,
              conversationId: conversationContext.conversationId,
            },
            subagentId: planSubagent.id,
            intent: plan.intent,
            nextStep: plan.nextStep,
            priority: prepared.priority,
            summary: prepared.summary,
            ownerAction: prepared.ownerAction,
          });
        }

        return maybeCreateHandoffRequest({
          context: conversationContext,
          plan,
          text: normalizedText,
          ...(prepared ? { prepared } : {}),
        });
      })()
    : null;

  const fallbackReplyText = [
    renderReplyPreview(representative, plan),
    handoff ? `已创建 owner inbox 收件项：${handoff.id}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  let replyText = fallbackReplyText;
  if (plan.nextStep === "answer") {
    const recentTurns = conversationContext
      ? await getRecentConversationTurns({
          conversationId: conversationContext.conversationId,
          limit: 6,
        })
      : [];
    const generated = await generateRepresentativeReply({
      representative,
      plan,
      subagent: planSubagent,
      userText: normalizedText,
      recalled,
      recentTurns,
      collectorState: conversationContext?.collectorState ?? null,
    });

    if (conversationContext && generated.contextTrace) {
      await botLifecycleHooks.emit({
        kind: "model_context_assembled",
        scope: {
          representativeId: conversationContext.representativeId,
          representativeSlug: conversationContext.representativeSlug,
          contactId: conversationContext.contactId,
          conversationId: conversationContext.conversationId,
        },
        subagentId: planSubagent.id,
        provider: generated.provider ?? "openai",
        model: generated.model ?? "gpt-5-mini",
        estimatedInputTokens: generated.contextTrace.estimatedInputTokens,
        segments: generated.contextTrace.segments,
        selectedKnowledgeTitles: generated.contextTrace.selectedKnowledgeTitles,
        selectedMemoryUseItemIds:
          generated.contextTrace.selectedMemoryUseItemIds,
      });
    }

    if (generated.ok) {
      replyText = [generated.replyText, handoff ? `已创建 owner inbox 收件项：${handoff.id}` : null]
        .filter(Boolean)
        .join("\n\n");

      if (conversationContext && generated.usage) {
        await recordModelUsage({
          context: conversationContext,
          provider: generated.provider,
          model: generated.model,
          ...(typeof generated.usage.inputTokens === "number"
            ? { inputTokens: generated.usage.inputTokens }
            : {}),
          ...(typeof generated.usage.outputTokens === "number"
            ? { outputTokens: generated.usage.outputTokens }
            : {}),
          ...(typeof generated.usage.totalTokens === "number"
            ? { totalTokens: generated.usage.totalTokens }
            : {}),
          ...(generated.usage.responseId ? { responseId: generated.usage.responseId } : {}),
          ...(typeof generated.usage.costCents === "number"
            ? { costCents: generated.usage.costCents }
            : {}),
          ...(typeof generated.usage.estimatedCostUsd === "number"
            ? { estimatedCostUsd: generated.usage.estimatedCostUsd }
            : {}),
        });
      }

      if (conversationContext) {
        await botLifecycleHooks.emit({
          kind: "model_reply_completed",
          scope: {
            representativeId: conversationContext.representativeId,
            representativeSlug: conversationContext.representativeSlug,
            contactId: conversationContext.contactId,
            conversationId: conversationContext.conversationId,
          },
          subagentId: planSubagent.id,
          provider: generated.provider,
          model: generated.model,
          success: true,
          ...(generated.usage?.responseId ? { responseId: generated.usage.responseId } : {}),
          ...(typeof generated.usage?.inputTokens === "number"
            ? { inputTokens: generated.usage.inputTokens }
            : {}),
          ...(typeof generated.usage?.outputTokens === "number"
            ? { outputTokens: generated.usage.outputTokens }
            : {}),
          ...(typeof generated.usage?.totalTokens === "number"
            ? { totalTokens: generated.usage.totalTokens }
            : {}),
          estimatedInputTokens: generated.contextTrace.estimatedInputTokens,
        });
      }

    } else {
      console.warn("Model runtime fallback:", generated.reason);
      if (conversationContext) {
        await botLifecycleHooks.emit({
          kind: "model_reply_completed",
          scope: {
            representativeId: conversationContext.representativeId,
            representativeSlug: conversationContext.representativeSlug,
            contactId: conversationContext.contactId,
            conversationId: conversationContext.conversationId,
          },
          subagentId: planSubagent.id,
          provider: generated.provider ?? "openai",
          model: generated.model ?? "gpt-5-mini",
          success: false,
          reason: generated.reason,
          ...(typeof generated.contextTrace?.estimatedInputTokens === "number"
            ? { estimatedInputTokens: generated.contextTrace.estimatedInputTokens }
            : {}),
        });
      }
    }
  }

  const replyMarkup = buildPlanKeyboardForConversation(
    plan,
    representative.slug,
  );
  await ctx.reply(replyText, replyMarkup ? { reply_markup: replyMarkup } : {});

  if (conversationContext) {
    await recordOutboundReply({
      context: conversationContext,
      plan,
      messageText: replyText,
      subagentId: planSubagent.id,
    });
  }
});

bot.catch((error) => {
  if (error.error instanceof TelegramMessageEditNotDurableError) {
    throw error;
  }
  return handleTelegramMiddlewareError({
    error: error.error,
    context: error.ctx,
  });
});

let telegramBotStopping = false;
let telegramBotStarted = false;
async function stopTelegramBot(
  signal: "SIGINT" | "SIGTERM" | "SUPERVISOR",
) {
  if (telegramBotStopping) {
    return;
  }
  telegramBotStopping = true;
  clearInterval(telegramPaymentRetryTimer);
  clearInterval(telegramMessageEditRetryTimer);
  console.info(
    JSON.stringify({
      event: "telegram_polling_stopping",
      signal,
    }),
  );
  if (!telegramBotStarted) {
    return;
  }
  try {
    await waitForTelegramMessageEditDurabilityFence();
    await bot.stop();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_polling_stop_failed",
        signal,
        error: sanitizeTelegramError(error),
      }),
    );
  }
}

return {
  config,
  ...(me.username ? { username: me.username } : {}),
  start: () => {
    telegramBotStarted = true;
    return runWithTelegramRuntimeContext(runtimeContext, () =>
      bot.start({
        timeout: telegramRuntimeConfig.pollingTimeoutSeconds,
        onStart: () => {
          console.info(
            JSON.stringify({
              event: "telegram_polling_started",
              internalConnectionId: config.internalConnectionId,
              botId: String(me.id),
              botUsername: me.username ?? "unknown",
              apiTimeoutSeconds: telegramRuntimeConfig.apiTimeoutSeconds,
              pollingTimeoutSeconds:
                telegramRuntimeConfig.pollingTimeoutSeconds,
            }),
          );
        },
      }),
    );
  },
  stop: stopTelegramBot,
};

async function deliverTelegramMemoryDisclosure(
  ctx: any,
  conversationId: string,
  inboundExternalMessageId: string,
) {
  return ensureTelegramMemoryDisclosure({
    conversationId,
    inboundExternalMessageId,
    send: async (text) => {
      const message = await ctx.reply(text);
      return {
        externalMessageId: String(message.message_id),
        deliveredAt: resolveTelegramProviderOccurredAt(message.date),
      };
    },
  });
}

async function applyTelegramMessageEdit(
  event: TelegramMessageEditEvent,
  lease: TelegramMessageEditLease,
): Promise<{
  conversationId: string;
  providerEditStatus: "applied" | "superseded";
}> {
  const target = await findTelegramInboundMessageEditTarget({
    chatId: event.chatId,
    externalMessageId: event.externalMessageId,
    senderId: String(event.telegramUserId),
  });
  if (!target) {
    throw new TelegramMessageEditRetryableError(
      "telegram_edit_target_not_found",
    );
  }
  const runtime = requireTelegramRuntimeContext();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTelegramMessageEditLease(tx, lease);
      try {
        const result = await editConversationMessage(
          {
            representativeSlug: target.representativeSlug,
            conversationId: target.conversationId,
            messageId: target.messageId,
            text: event.text,
            editedBy: `telegram:${event.telegramUserId}`,
            telegramGuard: {
              connectionId: runtime.botId,
              chatId: event.chatId,
              senderId: String(event.telegramUserId),
              externalMessageId: event.externalMessageId,
              updateId: event.updateId,
              editedAt: event.editedAt,
            },
          },
          tx,
        );
        return {
          conversationId: target.conversationId,
          providerEditStatus:
            result.providerEditStatus === "superseded"
              ? "superseded" as const
              : "applied" as const,
        };
      } catch (error) {
        if (!(error instanceof DelegationMessageEditConflictError)) throw error;
        // The provider edit cannot rewrite an input already committed to a
        // delegation task, but editConversationMessage has already fenced all
        // memory derived from the old source inside this transaction. Commit
        // that privacy control and acknowledge the durable edit event.
        return {
          conversationId: target.conversationId,
          providerEditStatus: "applied" as const,
        };
      }
    });
  } catch (error) {
    if (error instanceof TelegramMessageEditLeaseLostError) throw error;
    if (error instanceof Error) {
      if (error.message === "Telegram message edit scope is invalid.") {
        throw new TelegramMessageEditTerminalError(
          "telegram_edit_scope_invalid",
        );
      }
      if (error.message === "Redacted messages cannot be edited.") {
        throw new TelegramMessageEditTerminalError(
          "telegram_edit_message_redacted",
        );
      }
      if (error.message === "Message not found.") {
        throw new TelegramMessageEditRetryableError(
          "telegram_edit_target_not_found",
        );
      }
    }
    throw error;
  }
}

async function initializeTelegramBot() {
  try {
    const botInfo = await bot.api.getMe();
    if (String(botInfo.id) !== config.botId) {
      throw new Error(
        "Telegram Bot token resolved to a different numeric bot id.",
      );
    }
    bot.botInfo = botInfo;
    const synchronizedBindings =
      await synchronizeTelegramBotChannelBindings({
        internalConnectionId: config.internalConnectionId,
        botId: String(botInfo.id),
        legacy: config.legacy === true,
        ...(botInfo.username ? { username: botInfo.username } : {}),
      });
    await bot.api.setMyCommands(
      buildTelegramBotCommands(
        conversationPlatformMode !== "worker",
      ),
    );
    console.info(
      JSON.stringify({
        event: "telegram_channel_bindings_synchronized",
        internalConnectionId: config.internalConnectionId,
        botId: String(botInfo.id),
        count: synchronizedBindings,
      }),
    );
    return botInfo;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_startup_failed",
        internalConnectionId: config.internalConnectionId,
        botId: config.botId,
        error: sanitizeTelegramError(error),
      }),
    );
    throw error;
  }
}

async function sendPlansMessage(ctx: any, representative: Awaited<ReturnType<typeof getRepresentativeRuntimeConfig>>) {
  const replyMarkup = buildPlansKeyboard(representative.slug);
  await ctx.reply(
    buildWebRechargeMessage({
      representativeName: representative.name,
      rechargeUrl: buildRepresentativeWebRechargeUrl(representative.slug),
    }),
    replyMarkup ? { reply_markup: replyMarkup } : {},
  );
}

async function sendWebRechargeEntry(
  ctx: any,
  representativeSlug: string,
) {
  const representative = await getRepresentativeRuntimeConfig(
    representativeSlug,
  );
  const rechargeUrl = buildRepresentativeWebRechargeUrl(
    representative.slug,
  );
  const rechargeKeyboard = buildWebRechargeKeyboard(
    "打开 Web 充值",
    rechargeUrl,
  );
  await ctx.reply(
    buildWebRechargeMessage({
      representativeName: representative.name,
      rechargeUrl,
    }),
    rechargeKeyboard
      ? { reply_markup: rechargeKeyboard }
      : {},
  );
}

function stripBotMention(text: string, username: string | undefined): string {
  if (!username) {
    return text;
  }

  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`@${escaped}`, "ig"), "").trim();
}

function buildPlansKeyboard(
  representativeSlug: string,
): InlineKeyboard | undefined {
  const rechargeUrl = buildRepresentativeWebRechargeUrl(
    representativeSlug,
  );
  return buildWebRechargeKeyboard("打开 Web 充值", rechargeUrl);
}

function buildPlanKeyboardForConversation(
  plan: ConversationPlan,
  representativeSlug: string,
): InlineKeyboard | undefined {
  if (plan.suggestedPlan) {
    const rechargeUrl = buildRepresentativeWebRechargeUrl(
      representativeSlug,
    );
    return buildWebRechargeKeyboard("在 Web 继续服务", rechargeUrl);
  }

  return undefined;
}

function buildPlanReplyOptions(
  plan: ConversationPlan,
  representativeSlug: string,
) {
  const replyMarkup = buildPlanKeyboardForConversation(
    plan,
    representativeSlug,
  );
  return replyMarkup ? { reply_markup: replyMarkup } : {};
}

function parseStartPayload(
  payload: string | undefined,
  defaultRepresentativeSlug: string,
): {
  representativeSlug: string;
} {
  if (!payload) {
    return {
      representativeSlug: defaultRepresentativeSlug,
    };
  }

  const normalized = payload.trim().toLowerCase();

  if (normalized.startsWith("rep_")) {
    return {
      representativeSlug: normalized.slice(4) || defaultRepresentativeSlug,
    };
  }

  if (normalized.startsWith("buy_")) {
    const [representativeSlug] = normalized.slice(4).split("__");

    return {
      representativeSlug: representativeSlug || defaultRepresentativeSlug,
    };
  }

  if (normalized.startsWith("buy-")) {
    return {
      representativeSlug: defaultRepresentativeSlug,
    };
  }

  return {
    representativeSlug: normalized,
  };
}

function readRepresentativeSlugFromIdentityBinding(
  binding: unknown,
): string | null {
  if (!binding || typeof binding !== "object") return null;
  const value = binding as Record<string, unknown>;
  const direct =
    typeof value.representativeSlug === "string"
      ? value.representativeSlug.trim()
      : "";
  if (direct) return direct;

  for (const key of ["metadata", "challengeMetadata"]) {
    const metadata = value[key];
    if (!metadata || typeof metadata !== "object") continue;
    const representativeSlug = Reflect.get(
      metadata,
      "representativeSlug",
    );
    if (
      typeof representativeSlug === "string"
      && representativeSlug.trim()
    ) {
      return representativeSlug.trim();
    }
  }
  return null;
}

function mapMessageToChannel(chatType: string, isReplyToBot: boolean): Channel {
  if (chatType === "private") {
    return Channel.PRIVATE_CHAT;
  }

  return isReplyToBot ? Channel.GROUP_REPLY : Channel.GROUP_MENTION;
}

function buildDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
): { displayName?: string } {
  const value = [firstName, lastName].filter(Boolean).join(" ").trim();
  return value ? { displayName: value } : {};
}

function buildCollectorConversationPlan(
  collectorState: StructuredCollectorState,
): ConversationPlan {
  return {
    intent: collectorState.intent,
    audienceRole: "lead",
    action:
      collectorState.kind === "scheduling"
        ? "collect_scheduling_request"
        : "collect_quote_request",
    nextStep: "collect_intake",
    ...(collectorState.suggestedPlan ? { suggestedPlan: collectorState.suggestedPlan } : {}),
    reasons: ["Active structured collector in progress."],
    responseOutline: [formatStructuredCollectorPrompt(collectorState)],
  };
}

function isCollectorCancelMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "取消" || normalized === "cancel" || normalized === "stop";
}

async function resolveRepresentativeSlugForChat(
  chatType: string,
  chatId: number | string,
): Promise<string> {
  const defaultRepresentativeSlug =
    await getDefaultRepresentativeSlugForTelegramBot();

  return resolveTelegramRepresentativeSession({
    chatType,
    defaultRepresentativeSlug,
    readActiveRepresentativeSlug: () =>
      getActiveRepresentativeSlugForChat(chatId),
  });
}

async function handleComputeRequest(params: {
  ctx: any;
  representativeSlug: string;
  parsed: ReturnType<typeof parseComputeRequest>;
  rawText: string;
  representative?: Awaited<ReturnType<typeof getRepresentativeRuntimeConfig>>;
  conversationContext?: Awaited<ReturnType<typeof getConversationContext>>;
}) {
  const parsed = params.parsed;
  if (!parsed || !params.ctx.from || params.ctx.chat.type !== "private") {
    return;
  }

  const representative =
    params.representative ?? (await getRepresentativeRuntimeConfig(params.representativeSlug));
  const conversationContext =
    params.conversationContext ??
    (await getConversationContext(params.representativeSlug, {
      telegramUserId: params.ctx.from.id,
      ...(params.ctx.from.username ? { username: params.ctx.from.username } : {}),
      ...buildDisplayName(params.ctx.from.first_name, params.ctx.from.last_name),
      chatId: params.ctx.chat.id,
      channel: Channel.PRIVATE_CHAT,
    }));
  await assertConversationChannelDeliveryAvailable({
    conversationId: conversationContext.conversationId,
    channel: "telegram",
  });
  const computeSubagent = resolveComputeSubagent(parsed.capability);

  if (!conversationContext.compute.enabled) {
    const replyText = [
      representative.name,
      representative.tagline,
      "这个代表的隔离 compute lane 目前还没有打开。你可以先继续问 FAQ、收资料，或者让 owner 在 dashboard 里启用 compute。",
    ].join("\n\n");
    await params.ctx.reply(replyText);
    await recordComputeReply({
      context: conversationContext,
      messageText: replyText,
      capability: parsed.capability,
      outcome: "compute_disabled",
      subagentId: computeSubagent.id,
    });
    return;
  }

  await recordComputeInboundTurn({
    context: conversationContext,
    text: params.rawText,
    capability: parsed.capability,
    subagentId: computeSubagent.id,
  });

  try {
    const session = await createAudienceComputeSession({
      representativeId: conversationContext.representativeId,
      contactId: conversationContext.contactId,
      conversationId: conversationContext.conversationId,
      subagentId: computeSubagent.id,
      requestedCapabilities: [parsed.capability],
      reason: `telegram:${parsed.capability}`,
      requestedBaseImage: conversationContext.compute.baseImage,
    });

    await setActiveComputeSession({
      conversationId: conversationContext.conversationId,
      sessionId: session.session.id,
    });

    const execution = await executeAudienceTool(
      session.session.id,
      {
        ...parsed,
        subagentId: computeSubagent.id,
        hasPaidEntitlement:
          parsed.hasPaidEntitlement ||
          conversationContext.usage.passUnlocked ||
          conversationContext.usage.deepHelpUnlocked,
      },
    );

    const replyText = formatComputeReply({
      representativeName: representative.name,
      representativeTagline: representative.tagline,
      parsed,
      result: execution,
    });

    await params.ctx.reply(replyText, buildComputeReplyOptions(execution, representative));
    await recordComputeReply({
      context: conversationContext,
      messageText: replyText,
      capability: parsed.capability,
      outcome: execution.outcome,
      subagentId: computeSubagent.id,
    });
  } catch (error) {
    const replyText =
      error instanceof Error
        ? `Compute 请求暂时没跑起来：${error.message}`
        : "Compute 请求暂时没跑起来，请稍后重试。";
    await params.ctx.reply(replyText);
    await recordComputeReply({
      context: conversationContext,
      messageText: replyText,
      capability: parsed.capability,
      outcome: "compute_error",
      subagentId: computeSubagent.id,
    });
  }
}

function buildComputeReplyOptions(
  result: Awaited<ReturnType<typeof executeAudienceTool>>,
  representative: Awaited<ReturnType<typeof getRepresentativeRuntimeConfig>>,
) {
  if (
    result.outcome === "blocked"
    || result.outcome === "pending_approval"
    || result.outcome === "failed"
  ) {
    const rechargeUrl = buildRepresentativeWebRechargeUrl(
      representative.slug,
    );
    const rechargeKeyboard = buildWebRechargeKeyboard(
      "在 Web 继续服务",
      rechargeUrl,
    );
    return rechargeKeyboard
      ? { reply_markup: rechargeKeyboard }
      : {};
  }

  return {};
}

function buildWebRechargeKeyboard(
  label: string,
  rechargeUrl: string | null,
): InlineKeyboard | undefined {
  const buttonUrl = resolveTelegramInlineKeyboardUrl(rechargeUrl);
  return buttonUrl
    ? new InlineKeyboard().url(label, buttonUrl)
    : undefined;
}

function formatComputeReply(params: {
  representativeName: string;
  representativeTagline: string;
  parsed: NonNullable<ReturnType<typeof parseComputeRequest>>;
  result: Awaited<ReturnType<typeof executeAudienceTool>>;
}) {
  const header = [params.representativeName, params.representativeTagline].join("\n\n");
  const billingLine = formatComputeBilling(params.result);

  if (params.result.outcome === "pending_approval") {
    return [
      header,
      `这次 ${params.parsed.capability} 请求已经进入 owner 审批队列。`,
      params.result.approvalRequest
        ? `审批项：${params.result.approvalRequest.requestedActionSummary}\n风险：${params.result.approvalRequest.riskSummary}`
        : "命令已被策略挡住，等待人工确认后才会继续执行。",
      billingLine,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (params.result.outcome === "blocked") {
    return [
      header,
      "这次 compute 请求被当前策略直接挡住了，没有进入执行。",
      explainBlockedBudget(params.result),
      billingLine,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const artifactSummary =
    params.result.artifacts.length > 0
      ? params.result.artifacts
          .map((artifact) => `${artifact.kind}: ${artifact.summary ?? artifact.objectKey}`)
          .join("\n")
      : "这次没有生成可展示的 artifact。";

  if (params.result.outcome === "failed") {
    return [
      header,
      `这次 ${params.parsed.capability} 已经执行，但返回了失败状态。`,
      artifactSummary,
      billingLine,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    header,
    `这次 ${params.parsed.capability} 已经在隔离 compute plane 里跑完。`,
    artifactSummary,
    billingLine,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatComputeBilling(result: Awaited<ReturnType<typeof executeAudienceTool>>) {
  if (!result.billing) {
    return null;
  }

  const fragments = [];
  if (typeof result.billing.actualCredits === "number") {
    fragments.push(`实际消耗 ${result.billing.actualCredits} credits`);
  } else if (typeof result.billing.estimatedCredits === "number") {
    fragments.push(`预计消耗 ${result.billing.estimatedCredits} credits`);
  }
  if (typeof result.billing.conversationBudgetRemainingCredits === "number") {
    fragments.push(`当前会话剩余 ${result.billing.conversationBudgetRemainingCredits} credits`);
  }
  if (typeof result.billing.ownerBalanceCredits === "number") {
    fragments.push(`owner wallet ${result.billing.ownerBalanceCredits}`);
  }
  if (typeof result.billing.sponsorPoolCredit === "number") {
    fragments.push(`sponsor pool ${result.billing.sponsorPoolCredit}`);
  }

  return fragments.length ? fragments.join(" · ") : null;
}

function explainBlockedBudget(result: Awaited<ReturnType<typeof executeAudienceTool>>) {
  if (typeof result.billing?.conversationBudgetRemainingCredits === "number") {
    return `当前会话只有 ${result.billing.conversationBudgetRemainingCredits} compute credits，先解锁付费计划或等待 owner 补充预算后再试。`;
  }

  return "如果你要继续这类请求，可以先购买 Deep Help，或等待 owner 给予人工批准。";
}
}
