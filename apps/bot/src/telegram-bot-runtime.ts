import "dotenv/config";

import { demoRepresentative } from "@delegate/domain";
import {
  resolveTelegramGroupHandling
} from "@delegate/runtime";
import {
  ChannelUnavailableError,
  acceptInboundConversationMessage,
  assertConversationChannelDeliveryAvailable,
  consumeIdentityBindingChallenge,
  contactMemorySharingConsentContractVersion,
  createContactMemorySharingChallenge,
  editConversationMessage,
  grantContactMemorySharingConsent,
  privateChannelIdentityProviders,
  readContactMemorySharingChallengeToken,
  revokeContactMemorySharingConsent
} from "@delegate/web-data";
import { Channel } from "@prisma/client";
import { Bot, InlineKeyboard } from "grammy";

import {
  buildRepresentativeWebRechargeUrl,
  buildTelegramBotCommands,
  buildWebRechargeMessage,
  resolveTelegramInlineKeyboardUrl,
} from "./commerce-ux";
import {
  resolveTelegramConversationPlatformMode,
  shouldFailClosedAfterConversationPlatformWrite,
} from "./conversation-platform-mode";
import { prisma } from "./prisma";
import { getRepresentativeRuntimeConfig } from "./representative-config";
import {
  findTelegramInboundMessageEditTarget,
  getActiveRepresentativeSlugForChat,
  getConversationContext,
  getDefaultRepresentativeSlugForTelegramBot,
  persistAndProcessTelegramSuccessfulPayment,
  retryPendingTelegramSuccessfulPayments,
  setActiveRepresentativeForChat,
  synchronizeTelegramBotChannelBindings,
  validatePendingInvoice
} from "./runtime-store";
import {
  ensureTelegramMemoryDisclosure,
  resolveTelegramProviderOccurredAt,
  telegramContactMemoryDeleteText,
} from "./telegram-memory";
import {
  TelegramMessageEditLeaseLostError,
  TelegramMessageEditNotDurableError,
  TelegramMessageEditRetryableError,
  TelegramMessageEditTerminalError,
  lockTelegramMessageEditLease,
  persistAndProcessTelegramMessageEdit,
  retryPendingTelegramMessageEdits,
  type TelegramMessageEditEvent,
  type TelegramMessageEditLease,
} from "./telegram-message-edit-inbox";
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
      "这个 Bot 连接了多个对外代理。请从目标代表的公开页面重新打开 Telegram，以避免消息进入错误代表。",
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
        "当前无法切换对外代理。为避免消息进入错误代表，原会话保持不变，请稍后重试。",
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
        "账号绑定已经完成，但这个对外代理的 Bot 配置刚刚发生了变化，未切换当前会话。请回到代表公开页刷新后重新选择。",
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
          "跨渠道联系人记忆只会共享给当前对外代理，并且只在已验证为同一 Delegate 用户的 Web、Matrix、Telegram 私聊之间使用。",
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
        ? "已允许当前对外代理在已验证为同一 Delegate 用户的 Web、Matrix 和 Telegram 私聊之间使用联系人记忆。"
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
        ? "已立即停止当前对外代理的跨渠道联系人记忆召回；共享记忆的远端投影已进入可重试清理队列。各渠道原始会话和渠道内记忆不受影响。"
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
      "已立即停止召回当前对外代理与当前 Telegram 渠道下的联系人记忆；物理清理已进入可重试队列。代表经验和其他渠道不受影响。",
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
  if (ctx.chat.type !== "private" || !ctx.from || !ctx.message) {
    await ctx.reply("Compute 请求目前只在 bot 私聊里开放。");
    return;
  }
  const rawText = `/compute ${ctx.match?.trim() ?? ""}`.trim();
  if (conversationPlatformMode === "worker") {
    const representativeSlug = await resolveRepresentativeSlugForChat(
      ctx.chat.type,
      ctx.chat.id,
    );
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
    try {
      await deliverTelegramMemoryDisclosure(
        ctx,
        conversationContext.conversationId,
        String(ctx.message.message_id),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_memory_disclosure_compute_failed",
          updateId: ctx.update.update_id,
          error: sanitizeTelegramError(error),
        }),
      );
    }
    await acceptInboundConversationMessage({
      representativeSlug,
      conversationId: conversationContext.conversationId,
      text: rawText,
      senderId: String(ctx.from.id),
      senderDisplayName:
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
        || ctx.from.username
        || String(ctx.from.id),
      clientMessageId:
        `telegram:${me.id}:${ctx.chat.id}:${ctx.message.message_id}`,
      channel: "telegram",
      externalMessageId: String(ctx.message.message_id),
      queueGeneration: true,
      occurredAt: resolveTelegramProviderOccurredAt(ctx.message.date),
    });
    return;
  }


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
  const normalizedText = text.length > 0 ? text : rawText;

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

  if (!isPrivate) {
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
    && conversationPlatformMode === "worker"
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
    }
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

function buildWebRechargeKeyboard(
  label: string,
  rechargeUrl: string | null,
): InlineKeyboard | undefined {
  const buttonUrl = resolveTelegramInlineKeyboardUrl(rechargeUrl);
  return buttonUrl
    ? new InlineKeyboard().url(label, buttonUrl)
    : undefined;
}

}
