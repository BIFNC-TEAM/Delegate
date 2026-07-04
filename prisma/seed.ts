import "dotenv/config";

import { demoRepresentative } from "@delegate/domain";
import {
  AudienceRole,
  CapabilityPlanTier,
  ComputeFilesystemMode,
  ComputeNetworkMode,
  Channel,
  ContactStage,
  CreatorVerificationStatus,
  EventType,
  GroupActivation,
  HandoffStatus,
  InvoiceStatus,
  Prisma,
  PolicyDecision,
  PricingPlanType,
  PrismaClient,
  RepresentativeClaimStatus,
  SkillPackSource,
} from "@prisma/client";
import { pathToFileURL } from "node:url";

const prisma = new PrismaClient();

const DEMO_OWNER_ID = "owner_lin_demo";
const DEMO_WALLET_ID = "wallet_lin_demo";
const DEMO_USER_WALLET_ID = "user_wallet_demo_public";
const DEMO_AGENT_WALLET_ID = "agent_wallet_lin_demo";
const DEMO_OWNER_TELEGRAM_ID = "demo-owner-lin";
const DEMO_REPRESENTATIVE_ID = demoRepresentative.id;
const KNOWLEDGE_PACK_ID = "knowledge_lin_founder";

const CONTACTS = [
  {
    id: "contact_acme_ai",
    telegramUserId: "1001001",
    username: "acme_ai",
    displayName: "Acme AI",
    role: AudienceRole.LEAD,
    stage: ContactStage.WAITING_ON_OWNER,
    isPaid: true,
    source: "private_chat",
  },
  {
    id: "contact_creator_podcast",
    telegramUserId: "1001002",
    username: "creatorpodcast",
    displayName: "Creator Podcast",
    role: AudienceRole.MEDIA,
    stage: ContactStage.WAITING_ON_OWNER,
    isPaid: false,
    source: "group_mention",
  },
  {
    id: "contact_anonymous_refund",
    telegramUserId: "1001003",
    displayName: "匿名用户",
    role: AudienceRole.OTHER,
    stage: ContactStage.WAITING_ON_OWNER,
    isPaid: true,
    source: "private_chat",
  },
  {
    id: "contact_community_angel",
    telegramUserId: "1001004",
    username: "communityangel",
    displayName: "Community Angel",
    role: AudienceRole.COMMUNITY,
    stage: ContactStage.WON,
    isPaid: true,
    source: "private_chat",
  },
] as const;

type ContactFixture = (typeof CONTACTS)[number];

export async function seedDatabase(client: PrismaClient = prisma): Promise<void> {
  const now = new Date();
  const hoursAgo = (value: number) => new Date(now.getTime() - value * 60 * 60 * 1000);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const acmeCreatedAt = new Date(startOfToday.getTime() + 9 * 60 * 60 * 1000);
  const creatorCreatedAt = new Date(startOfToday.getTime() + 11 * 60 * 60 * 1000);
  const refundCreatedAt = hoursAgo(30);
  const sponsorCreatedAt = new Date(startOfToday.getTime() + 13 * 60 * 60 * 1000);

  await client.$transaction(async (tx) => {
    const contactIdsByFixtureId = new Map<ContactFixture["id"], string>();
    const conversationIdsByFixtureKey = new Map<string, string>();
    const requireContactId = (fixtureId: ContactFixture["id"]) => {
      const id = contactIdsByFixtureId.get(fixtureId);
      if (!id) {
        throw new Error(`Seed contact fixture "${fixtureId}" was not created.`);
      }
      return id;
    };
    const requireConversationId = (fixtureKey: string) => {
      const id = conversationIdsByFixtureKey.get(fixtureKey);
      if (!id) {
        throw new Error(`Seed conversation fixture "${fixtureKey}" was not created.`);
      }
      return id;
    };

    await tx.owner.upsert({
      where: { telegramUserId: DEMO_OWNER_TELEGRAM_ID },
      create: {
        id: DEMO_OWNER_ID,
        telegramUserId: DEMO_OWNER_TELEGRAM_ID,
        displayName: demoRepresentative.ownerName,
        handle: "lin",
        timezone: "Asia/Shanghai",
        creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      },
      update: {
        displayName: demoRepresentative.ownerName,
        handle: "lin",
        timezone: "Asia/Shanghai",
        creatorVerificationStatus: CreatorVerificationStatus.VERIFIED,
      },
    });

    await tx.wallet.upsert({
      where: { ownerId: DEMO_OWNER_ID },
      create: {
        id: DEMO_WALLET_ID,
        ownerId: DEMO_OWNER_ID,
        balanceCredits: 240,
        sponsorPoolCredit: 1200,
        starsBalance: 2060,
      },
      update: {
        balanceCredits: 240,
        sponsorPoolCredit: 1200,
        starsBalance: 2060,
      },
    });

    const representative = await tx.representative.upsert({
      where: { slug: demoRepresentative.slug },
      create: {
        id: DEMO_REPRESENTATIVE_ID,
        ownerId: DEMO_OWNER_ID,
        slug: demoRepresentative.slug,
        displayName: demoRepresentative.name,
        roleSummary: demoRepresentative.tagline,
        tone: demoRepresentative.tone,
        publicMode: true,
        claimStatus: RepresentativeClaimStatus.CLAIMED,
        groupModeEnabled: true,
        groupActivation: mapGroupActivationToDb(demoRepresentative.groupActivation),
        humanInLoop: true,
        languages: demoRepresentative.languages,
        freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
        freeScope: demoRepresentative.contract.freeScope,
        paywalledIntents: demoRepresentative.contract.paywalledIntents,
        handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
        freeMonthlyCredit: 100,
        handoffPrompt: demoRepresentative.handoffPrompt,
        allowedSkills: demoRepresentative.skills,
        actionGate: demoRepresentative.actionGate,
        computeEnabled: false,
        computeDefaultPolicyMode: PolicyDecision.ASK,
        computeBaseImage: "debian:bookworm-slim",
        computeMaxSessionMinutes: 15,
        computeAutoApproveBudgetCents: 0,
        computeArtifactRetentionDays: 14,
        computeNetworkMode: ComputeNetworkMode.NO_NETWORK,
        computeNetworkAllowlist: [],
        computeFilesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
      },
      update: {
        ownerId: DEMO_OWNER_ID,
        displayName: demoRepresentative.name,
        roleSummary: demoRepresentative.tagline,
        tone: demoRepresentative.tone,
        publicMode: true,
        claimStatus: RepresentativeClaimStatus.CLAIMED,
        groupModeEnabled: true,
        groupActivation: mapGroupActivationToDb(demoRepresentative.groupActivation),
        humanInLoop: true,
        languages: demoRepresentative.languages,
        freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
        freeScope: demoRepresentative.contract.freeScope,
        paywalledIntents: demoRepresentative.contract.paywalledIntents,
        handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
        freeMonthlyCredit: 100,
        handoffPrompt: demoRepresentative.handoffPrompt,
        allowedSkills: demoRepresentative.skills,
        actionGate: demoRepresentative.actionGate,
        computeEnabled: false,
        computeDefaultPolicyMode: PolicyDecision.ASK,
        computeBaseImage: "debian:bookworm-slim",
        computeMaxSessionMinutes: 15,
        computeAutoApproveBudgetCents: 0,
        computeArtifactRetentionDays: 14,
        computeNetworkMode: ComputeNetworkMode.NO_NETWORK,
        computeNetworkAllowlist: [],
        computeFilesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
      },
    });

    await tx.userWallet.upsert({
      where: { externalUserId: "demo-public-user" },
      create: {
        id: DEMO_USER_WALLET_ID,
        externalUserId: "demo-public-user",
        telegramUserId: "demo-public-telegram-user",
        displayName: "Demo Public User",
        currency: "CNY",
        cashBalanceCents: 0,
      },
      update: {
        telegramUserId: "demo-public-telegram-user",
        displayName: "Demo Public User",
        currency: "CNY",
      },
    });

    await tx.agentWallet.upsert({
      where: { representativeId: representative.id },
      create: {
        id: DEMO_AGENT_WALLET_ID,
        representativeId: representative.id,
        currency: "CNY",
        tokenBalance: 0,
        totalPurchasedTokens: 0,
        totalConsumedTokens: 0,
        tokenUnitPriceCents: 1,
        creatorRevenueShareBps: 2000,
      },
      update: {
        currency: "CNY",
        tokenUnitPriceCents: 1,
        creatorRevenueShareBps: 2000,
      },
    });

    const defaultPolicyProfile = await upsertDefaultCapabilityPolicyProfile(tx, representative.id);
    await upsertManagedCapabilityPolicyProfile(tx, representative.id);
    await upsertOwnerManagedCapabilityProfiles(tx, DEMO_OWNER_ID);

    await tx.knowledgePack.upsert({
      where: { representativeId: representative.id },
      create: {
        id: KNOWLEDGE_PACK_ID,
        representativeId: representative.id,
        identitySummary: demoRepresentative.knowledgePack.identitySummary,
        faq: demoRepresentative.knowledgePack.faq,
        materials: demoRepresentative.knowledgePack.materials,
        policies: demoRepresentative.knowledgePack.policies,
      },
      update: {
        identitySummary: demoRepresentative.knowledgePack.identitySummary,
        faq: demoRepresentative.knowledgePack.faq,
        materials: demoRepresentative.knowledgePack.materials,
        policies: demoRepresentative.knowledgePack.policies,
      },
    });

    await tx.pricingPlan.deleteMany({
      where: { representativeId: representative.id },
    });

    await tx.pricingPlan.createMany({
      data: demoRepresentative.pricing.map((plan) => ({
        id: `pricing_${representative.id}_${plan.tier}`,
        representativeId: representative.id,
        type: mapPricingPlanType(plan.tier),
        name: plan.name,
        starsAmount: plan.stars,
        summary: plan.summary,
        includedReplies: plan.includedReplies,
        includesPriorityHandoff: plan.includesPriorityHandoff,
      })),
    });

    const skillPackIdsBySlug = new Map<string, string>();

    for (const pack of demoRepresentative.skillPacks) {
      const skillPack = await tx.skillPack.upsert({
        where: {
          source_slug: {
            source: mapSkillPackSourceToDb(pack.source),
            slug: pack.slug,
          },
        },
        create: {
          id: pack.id,
          source: mapSkillPackSourceToDb(pack.source),
          slug: pack.slug,
          displayName: pack.displayName,
          summary: pack.summary,
          version: pack.version ?? null,
          sourceUrl: pack.sourceUrl ?? null,
          ownerHandle: pack.ownerHandle ?? null,
          verificationTier: pack.verificationTier ?? null,
          capabilityTags: pack.capabilityTags,
          executesCode: pack.executesCode,
        },
        update: {
          displayName: pack.displayName,
          summary: pack.summary,
          version: pack.version ?? null,
          sourceUrl: pack.sourceUrl ?? null,
          ownerHandle: pack.ownerHandle ?? null,
          verificationTier: pack.verificationTier ?? null,
          capabilityTags: pack.capabilityTags,
          executesCode: pack.executesCode,
        },
      });

      skillPackIdsBySlug.set(pack.slug, skillPack.id);

      await tx.representativeSkillPack.upsert({
        where: {
          representativeId_skillPackId: {
            representativeId: representative.id,
            skillPackId: skillPack.id,
          },
        },
        create: {
          id: `rep_skill_pack_${skillPack.id}`,
          representativeId: representative.id,
          skillPackId: skillPack.id,
          enabled: pack.enabled,
          installStatus: pack.installStatus,
          installedVersion: pack.version ?? null,
          installedAt: pack.installStatus === "available" ? null : now,
        },
        update: {
          enabled: pack.enabled,
          installStatus: pack.installStatus,
          installedVersion: pack.version ?? null,
          installedAt: pack.installStatus === "available" ? null : now,
        },
      });
    }

    for (const contact of CONTACTS) {
      const upsertedContact = await tx.contact.upsert({
        where: {
          representativeId_telegramUserId: {
            representativeId: representative.id,
            telegramUserId: contact.telegramUserId,
          },
        },
        create: {
          id: contact.id,
          representativeId: representative.id,
          telegramUserId: contact.telegramUserId,
          username: contact.username ?? null,
          displayName: contact.displayName,
          role: contact.role,
          stage: contact.stage,
          isPaid: contact.isPaid,
          source: contact.source,
          lastSeenAt: now,
        },
        update: {
          username: contact.username ?? null,
          displayName: contact.displayName,
          role: contact.role,
          stage: contact.stage,
          isPaid: contact.isPaid,
          source: contact.source,
          lastSeenAt: now,
        },
      });

      contactIdsByFixtureId.set(contact.id, upsertedContact.id);
    }

    const conversations = [
      {
        key: "conversation_acme",
        contactFixtureId: CONTACTS[0].id,
        telegramChatId: "90001",
        channel: Channel.PRIVATE_CHAT,
        state: "ACTIVE",
        freeRepliesUsed: 4,
        passUnlockedAt: hoursAgo(12),
        deepHelpUnlockedAt: null,
        createdAt: acmeCreatedAt,
        lastMessageAt: hoursAgo(2),
      },
      {
        key: "conversation_creator",
        contactFixtureId: CONTACTS[1].id,
        telegramChatId: "90002",
        channel: Channel.PRIVATE_CHAT,
        state: "ACTIVE",
        freeRepliesUsed: 2,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        createdAt: creatorCreatedAt,
        lastMessageAt: hoursAgo(5),
      },
      {
        key: "conversation_refund",
        contactFixtureId: CONTACTS[2].id,
        telegramChatId: "90003",
        channel: Channel.PRIVATE_CHAT,
        state: "ACTIVE",
        freeRepliesUsed: 1,
        passUnlockedAt: hoursAgo(36),
        deepHelpUnlockedAt: hoursAgo(20),
        createdAt: refundCreatedAt,
        lastMessageAt: hoursAgo(6),
      },
      {
        key: "conversation_sponsor",
        contactFixtureId: CONTACTS[3].id,
        telegramChatId: "90004",
        channel: Channel.PRIVATE_CHAT,
        state: "ACTIVE",
        freeRepliesUsed: 0,
        passUnlockedAt: null,
        deepHelpUnlockedAt: null,
        createdAt: sponsorCreatedAt,
        lastMessageAt: hoursAgo(1),
      },
    ] as const;

    for (const conversation of conversations) {
      const contactId = requireContactId(conversation.contactFixtureId);
      const upsertedConversation = await tx.conversation.upsert({
        where: {
          representativeId_telegramChatId_contactId: {
            representativeId: representative.id,
            telegramChatId: conversation.telegramChatId,
            contactId,
          },
        },
        create: {
          id: conversation.key,
          representativeId: representative.id,
          contactId,
          telegramChatId: conversation.telegramChatId,
          channel: conversation.channel,
          state: conversation.state,
          freeRepliesUsed: conversation.freeRepliesUsed,
          passUnlockedAt: conversation.passUnlockedAt,
          deepHelpUnlockedAt: conversation.deepHelpUnlockedAt,
          createdAt: conversation.createdAt,
          lastMessageAt: conversation.lastMessageAt,
        },
        update: {
          contactId,
          channel: conversation.channel,
          state: conversation.state,
          freeRepliesUsed: conversation.freeRepliesUsed,
          passUnlockedAt: conversation.passUnlockedAt,
          deepHelpUnlockedAt: conversation.deepHelpUnlockedAt,
          lastMessageAt: conversation.lastMessageAt,
        },
      });

      conversationIdsByFixtureKey.set(conversation.key, upsertedConversation.id);
    }

    await tx.conversationTurn.deleteMany({
      where: {
        conversationId: {
          in: conversations.map((conversation) => requireConversationId(conversation.key)),
        },
      },
    });

    await tx.conversationTurn.createMany({
      data: [
        {
          id: "turn_acme_1",
          conversationId: requireConversationId("conversation_acme"),
          direction: "inbound",
          messageText: "我们想做一个一周内启动的 inbound automation 合作，预算可以先给范围。",
          intent: "collaboration",
          summary: "Acme AI wants a fast-moving automation engagement with budget context.",
          createdAt: hoursAgo(2),
        },
        {
          id: "turn_acme_2",
          conversationId: requireConversationId("conversation_acme"),
          direction: "outbound",
          messageText: "我可以先完成 intake，并把需要 founder 决策的部分送进人工收件箱。",
          intent: "handoff",
          summary: "Representative routed Acme AI to intake plus owner review.",
          createdAt: hoursAgo(2),
        },
        {
          id: "turn_creator_1",
          conversationId: requireConversationId("conversation_creator"),
          direction: "inbound",
          messageText: "我们是 Creator Podcast，想确认 founder 是否愿意接受一次播客采访。",
          intent: "media",
          summary: "Podcast host is requesting founder interview availability.",
          createdAt: hoursAgo(5),
        },
        {
          id: "turn_refund_1",
          conversationId: requireConversationId("conversation_refund"),
          direction: "inbound",
          messageText: "我需要退款，这个请求是不是需要 founder 本人批准？",
          intent: "refund",
          summary: "Paid user is asking for a refund and owner approval.",
          createdAt: hoursAgo(6),
        },
        {
          id: "turn_sponsor_1",
          conversationId: requireConversationId("conversation_sponsor"),
          direction: "inbound",
          messageText: "我想赞助这个代表的公共额度池。",
          intent: "pricing",
          summary: "Community supporter wants to fund the sponsor pool.",
          createdAt: hoursAgo(1),
        },
      ],
    });

    const intakeSubmissions = [
      {
        id: "intake_acme",
        contactId: requireContactId(CONTACTS[0].id),
        conversationId: requireConversationId("conversation_acme"),
        requestType: "collaboration",
        payload: {
          company: "Acme AI",
          goal: "Inbound automation rollout",
          budget: "$8k-$12k",
          timeline: "1 week",
          needsFounder: true,
        },
        priorityScore: 92,
        recommendedNextStep: "owner_review",
      },
      {
        id: "intake_creator",
        contactId: requireContactId(CONTACTS[1].id),
        conversationId: requireConversationId("conversation_creator"),
        requestType: "media",
        payload: {
          outlet: "Creator Podcast",
          topic: "AI-native representatives on Telegram",
          deadline: "This week",
          needsFounder: true,
        },
        priorityScore: 68,
        recommendedNextStep: "owner_review",
      },
      {
        id: "intake_refund",
        contactId: requireContactId(CONTACTS[2].id),
        conversationId: requireConversationId("conversation_refund"),
        requestType: "refund",
        payload: {
          requestedBy: "anonymous",
          asksForRefund: true,
          reason: "Needs owner approval before refunding",
        },
        priorityScore: 95,
        recommendedNextStep: "owner_approval",
      },
    ] as const;

    for (const intake of intakeSubmissions) {
      await tx.intakeSubmission.upsert({
        where: { id: intake.id },
        create: {
          id: intake.id,
          representativeId: representative.id,
          contactId: intake.contactId,
          conversationId: intake.conversationId,
          requestType: intake.requestType,
          payload: intake.payload,
          priorityScore: intake.priorityScore,
          recommendedNextStep: intake.recommendedNextStep,
          createdAt: now,
        },
        update: {
          requestType: intake.requestType,
          payload: intake.payload,
          priorityScore: intake.priorityScore,
          recommendedNextStep: intake.recommendedNextStep,
        },
      });
    }

    const handoffRequests = [
      {
        id: "handoff_acme",
        contactId: requireContactId(CONTACTS[0].id),
        conversationId: requireConversationId("conversation_acme"),
        intakeSubmissionId: "intake_acme",
        reason: "collaboration",
        summary: "想谈一周内启动的自动化合作，预算已说明。",
        recommendedPriority: 92,
        recommendedOwnerAction: "Review budget and decide whether to accept a founder call.",
        status: HandoffStatus.OPEN,
        createdAt: hoursAgo(2),
      },
      {
        id: "handoff_creator",
        contactId: requireContactId(CONTACTS[1].id),
        conversationId: requireConversationId("conversation_creator"),
        intakeSubmissionId: "intake_creator",
        reason: "media",
        summary: "媒体采访请求，需要 founder 本人确认档期。",
        recommendedPriority: 68,
        recommendedOwnerAction: "Confirm availability for a podcast recording slot.",
        status: HandoffStatus.REVIEWING,
        createdAt: hoursAgo(5),
      },
      {
        id: "handoff_refund",
        contactId: requireContactId(CONTACTS[2].id),
        conversationId: requireConversationId("conversation_refund"),
        intakeSubmissionId: "intake_refund",
        reason: "refund",
        summary: "要求退款，触发 ask-first 规则。",
        recommendedPriority: 95,
        recommendedOwnerAction: "Approve or decline refund before sending a human response.",
        status: HandoffStatus.OPEN,
        createdAt: hoursAgo(6),
      },
    ] as const;

    for (const handoff of handoffRequests) {
      await tx.handoffRequest.upsert({
        where: { id: handoff.id },
        create: {
          id: handoff.id,
          representativeId: representative.id,
          contactId: handoff.contactId,
          conversationId: handoff.conversationId,
          intakeSubmissionId: handoff.intakeSubmissionId,
          reason: handoff.reason,
          summary: handoff.summary,
          recommendedPriority: handoff.recommendedPriority,
          recommendedOwnerAction: handoff.recommendedOwnerAction,
          status: handoff.status,
          createdAt: handoff.createdAt,
        },
        update: {
          summary: handoff.summary,
          recommendedPriority: handoff.recommendedPriority,
          recommendedOwnerAction: handoff.recommendedOwnerAction,
          status: handoff.status,
        },
      });
    }

    const invoices = [
      {
        id: "invoice_acme_pass",
        contactId: requireContactId(CONTACTS[0].id),
        conversationId: requireConversationId("conversation_acme"),
        planType: PricingPlanType.PASS,
        title: "Pass",
        payload: "delegate:seed:invoice:acme-pass",
        starsAmount: 180,
        invoiceLink: null,
        telegramPaymentChargeId: "tg_charge_acme_pass",
        providerPaymentChargeId: "xtr_acme_pass",
        status: InvoiceStatus.PAID,
        paidAt: hoursAgo(12),
        refundedAt: null,
        createdAt: hoursAgo(13),
      },
      {
        id: "invoice_refund_deep_help",
        contactId: requireContactId(CONTACTS[2].id),
        conversationId: requireConversationId("conversation_refund"),
        planType: PricingPlanType.DEEP_HELP,
        title: "Deep Help",
        payload: "delegate:seed:invoice:refund-deep-help",
        starsAmount: 680,
        invoiceLink: null,
        telegramPaymentChargeId: "tg_charge_refund_deep_help",
        providerPaymentChargeId: "xtr_refund_deep_help",
        status: InvoiceStatus.PAID,
        paidAt: hoursAgo(20),
        refundedAt: null,
        createdAt: hoursAgo(21),
      },
      {
        id: "invoice_sponsor_pool",
        contactId: requireContactId(CONTACTS[3].id),
        conversationId: requireConversationId("conversation_sponsor"),
        planType: PricingPlanType.SPONSOR,
        title: "Sponsor",
        payload: "delegate:seed:invoice:sponsor-pool",
        starsAmount: 1200,
        invoiceLink: null,
        telegramPaymentChargeId: "tg_charge_sponsor_pool",
        providerPaymentChargeId: "xtr_sponsor_pool",
        status: InvoiceStatus.FULFILLED,
        paidAt: hoursAgo(1),
        refundedAt: null,
        createdAt: hoursAgo(2),
      },
    ] as const;

    for (const invoice of invoices) {
      await tx.invoice.upsert({
        where: { id: invoice.id },
        create: {
          id: invoice.id,
          representativeId: representative.id,
          contactId: invoice.contactId,
          conversationId: invoice.conversationId,
          planType: invoice.planType,
          title: invoice.title,
          payload: invoice.payload,
          starsAmount: invoice.starsAmount,
          invoiceLink: invoice.invoiceLink,
          telegramPaymentChargeId: invoice.telegramPaymentChargeId,
          providerPaymentChargeId: invoice.providerPaymentChargeId,
          status: invoice.status,
          paidAt: invoice.paidAt,
          refundedAt: invoice.refundedAt,
          createdAt: invoice.createdAt,
        },
        update: {
          planType: invoice.planType,
          title: invoice.title,
          payload: invoice.payload,
          starsAmount: invoice.starsAmount,
          invoiceLink: invoice.invoiceLink,
          telegramPaymentChargeId: invoice.telegramPaymentChargeId,
          providerPaymentChargeId: invoice.providerPaymentChargeId,
          status: invoice.status,
          paidAt: invoice.paidAt,
          refundedAt: invoice.refundedAt,
        },
      });
    }

    await tx.eventAudit.deleteMany({
      where: { representativeId: representative.id },
    });

    await tx.eventAudit.createMany({
      data: [
        {
          id: "event_message_acme",
          representativeId: representative.id,
          contactId: requireContactId(CONTACTS[0].id),
          conversationId: requireConversationId("conversation_acme"),
          type: EventType.MESSAGE_RECEIVED,
          payload: {
            intent: "collaboration",
            source: "seed",
          },
          createdAt: hoursAgo(2),
        },
        {
          id: "event_handoff_acme",
          representativeId: representative.id,
          contactId: requireContactId(CONTACTS[0].id),
          conversationId: requireConversationId("conversation_acme"),
          type: EventType.HANDOFF_REQUESTED,
          payload: {
            handoffId: "handoff_acme",
            priority: 92,
          },
          createdAt: hoursAgo(2),
        },
        {
          id: "event_payment_acme",
          representativeId: representative.id,
          contactId: requireContactId(CONTACTS[0].id),
          conversationId: requireConversationId("conversation_acme"),
          type: EventType.PAYMENT_CONFIRMED,
          payload: {
            invoiceId: "invoice_acme_pass",
            starsAmount: 180,
            status: "PAID",
          },
          createdAt: hoursAgo(12),
        },
        {
          id: "event_payment_refund",
          representativeId: representative.id,
          contactId: requireContactId(CONTACTS[2].id),
          conversationId: requireConversationId("conversation_refund"),
          type: EventType.PAYMENT_CONFIRMED,
          payload: {
            invoiceId: "invoice_refund_deep_help",
            starsAmount: 680,
            status: "PAID",
          },
          createdAt: hoursAgo(20),
        },
        {
          id: "event_payment_sponsor",
          representativeId: representative.id,
          contactId: requireContactId(CONTACTS[3].id),
          conversationId: requireConversationId("conversation_sponsor"),
          type: EventType.PAYMENT_CONFIRMED,
          payload: {
            invoiceId: "invoice_sponsor_pool",
            starsAmount: 1200,
            status: "FULFILLED",
          },
          createdAt: hoursAgo(1),
        },
      ],
    });

    if (!skillPackIdsBySlug.has("founder-core")) {
      throw new Error("Expected founder-core skill pack to be seeded.");
    }

    if (!defaultPolicyProfile.id) {
      throw new Error("Expected default compute policy profile to be seeded.");
    }
  });
}

async function upsertDefaultCapabilityPolicyProfile(
  tx: Prisma.TransactionClient,
  representativeId: string,
) {
  const existingProfile = await tx.capabilityPolicyProfile.findFirst({
    where: {
      representativeId,
      isDefault: true,
    },
    select: {
      id: true,
    },
  });

  const profileId = existingProfile?.id ?? `cap_profile_${representativeId}`;

  const profile = existingProfile
    ? await tx.capabilityPolicyProfile.update({
        where: { id: profileId },
        data: {
          name: "Default Compute Guardrail",
          isDefault: true,
          enabled: true,
          isManaged: false,
          managedScope: "REPRESENTATIVE_DEFAULT",
          managedSource: null,
          precedence: 0,
          defaultDecision: PolicyDecision.ASK,
          maxSessionMinutes: 15,
          maxParallelSessions: 1,
          maxCommandSeconds: 30,
          artifactRetentionDays: 14,
          networkMode: ComputeNetworkMode.NO_NETWORK,
          networkAllowlist: [],
          filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
        },
      })
    : await tx.capabilityPolicyProfile.create({
        data: {
          id: profileId,
          representativeId,
          name: "Default Compute Guardrail",
          isDefault: true,
          enabled: true,
          isManaged: false,
          managedScope: "REPRESENTATIVE_DEFAULT",
          precedence: 0,
          defaultDecision: PolicyDecision.ASK,
          maxSessionMinutes: 15,
          maxParallelSessions: 1,
          maxCommandSeconds: 30,
          artifactRetentionDays: 14,
          networkMode: ComputeNetworkMode.NO_NETWORK,
          networkAllowlist: [],
          filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
        },
      });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: [
      {
        id: `${profile.id}_exec_safe_readonly`,
        profileId: profile.id,
        capability: "EXEC",
        decision: "ALLOW",
        commandPattern: "^(pwd|ls|cat|find|grep|head|tail)(?:\\s+[A-Za-z0-9_./:@=-]+)*\\s*$",
        priority: 100,
        requiresPaidPlan: false,
        requiresHumanApproval: false,
      },
      {
        id: `${profile.id}_read_workspace`,
        profileId: profile.id,
        capability: "READ",
        decision: "ALLOW",
        pathPattern: "^/workspace(?:/|$)",
        resourceScopeCondition: "WORKSPACE",
        priority: 90,
        requiresPaidPlan: false,
        requiresHumanApproval: false,
      },
      {
        id: `${profile.id}_write_workspace`,
        profileId: profile.id,
        capability: "WRITE",
        decision: "ASK",
        pathPattern: "^/workspace(?:/|$)",
        resourceScopeCondition: "WORKSPACE",
        priority: 80,
        requiresPaidPlan: false,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_browser_review`,
        profileId: profile.id,
        capability: "BROWSER",
        decision: "ASK",
        domainPattern: ".*",
        resourceScopeCondition: "BROWSER_LANE",
        priority: 70,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
    ],
  });

  return profile;
}

async function upsertManagedCapabilityPolicyProfile(
  tx: Prisma.TransactionClient,
  representativeId: string,
) {
  const profileId = `cap_profile_managed_${representativeId}`;
  const profile = await tx.capabilityPolicyProfile.upsert({
    where: { id: profileId },
    update: {
      name: "Delegate Managed Guardrail",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "DELEGATE_MANAGED",
      managedSource: "delegate-default",
      editableByOwner: false,
      ownerId: null,
      contactTrustTierCondition: null,
      precedence: 100,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: profileId,
      representativeId,
      name: "Delegate Managed Guardrail",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "DELEGATE_MANAGED",
      managedSource: "delegate-default",
      editableByOwner: false,
      precedence: 100,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: [
      {
        id: `${profile.id}_browser_paid_private`,
        profileId: profile.id,
        capability: "BROWSER",
        decision: "ASK",
        domainPattern: ".*",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 220,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_process_paid`,
        profileId: profile.id,
        capability: "PROCESS",
        decision: "ASK",
        resourceScopeCondition: "WORKSPACE",
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 210,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_mcp_paid`,
        profileId: profile.id,
        capability: "MCP",
        decision: "ASK",
        resourceScopeCondition: "REMOTE_MCP",
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 208,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${profile.id}_write_secret_paths`,
        profileId: profile.id,
        capability: "WRITE",
        decision: "DENY",
        pathPattern: "^/workspace(?:/.*)?/(?:\\.env(?:\\..*)?|.*\\.pem|.*\\.key)$",
        resourceScopeCondition: "WORKSPACE",
        priority: 205,
        requiresPaidPlan: false,
        requiresHumanApproval: false,
      },
    ],
  });

  return profile;
}

async function upsertOwnerManagedCapabilityProfiles(
  tx: Prisma.TransactionClient,
  ownerId: string,
) {
  const baselineProfileId = `cap_profile_owner_baseline_${ownerId}`;
  const trustedProfileId = `cap_profile_owner_trusted_${ownerId}`;

  const baselineProfile = await tx.capabilityPolicyProfile.upsert({
    where: { id: baselineProfileId },
    update: {
      ownerId,
      representativeId: null,
      name: "Owner Managed Baseline",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "OWNER_MANAGED",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: null,
      precedence: 80,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: baselineProfileId,
      ownerId,
      representativeId: null,
      name: "Owner Managed Baseline",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "OWNER_MANAGED",
      managedSource: "owner-managed",
      editableByOwner: true,
      precedence: 80,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  const trustedProfile = await tx.capabilityPolicyProfile.upsert({
    where: { id: trustedProfileId },
    update: {
      ownerId,
      representativeId: null,
      name: "Trusted Customer Overlay",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "CUSTOMER_TRUST_TIER",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: "VERIFIED",
      precedence: 90,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
    create: {
      id: trustedProfileId,
      ownerId,
      representativeId: null,
      name: "Trusted Customer Overlay",
      isDefault: false,
      enabled: true,
      isManaged: true,
      managedScope: "CUSTOMER_TRUST_TIER",
      managedSource: "owner-managed",
      editableByOwner: true,
      contactTrustTierCondition: "VERIFIED",
      precedence: 90,
      defaultDecision: PolicyDecision.ASK,
      maxSessionMinutes: 15,
      maxParallelSessions: 1,
      maxCommandSeconds: 30,
      artifactRetentionDays: 14,
      networkMode: ComputeNetworkMode.NO_NETWORK,
      networkAllowlist: [],
      filesystemMode: ComputeFilesystemMode.WORKSPACE_ONLY,
    },
  });

  await tx.capabilityPolicyRule.deleteMany({
    where: {
      profileId: {
        in: [baselineProfile.id, trustedProfile.id],
      },
    },
  });

  await tx.capabilityPolicyRule.createMany({
    data: [
      {
        id: `${baselineProfile.id}_browser_baseline`,
        profileId: baselineProfile.id,
        capability: "BROWSER",
        decision: "ASK",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 160,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${baselineProfile.id}_mcp_baseline`,
        profileId: baselineProfile.id,
        capability: "MCP",
        decision: "ASK",
        resourceScopeCondition: "REMOTE_MCP",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 155,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${trustedProfile.id}_browser_trusted`,
        profileId: trustedProfile.id,
        capability: "BROWSER",
        decision: "ASK",
        resourceScopeCondition: "BROWSER_LANE",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 170,
        requiresPaidPlan: true,
        requiresHumanApproval: true,
      },
      {
        id: `${trustedProfile.id}_mcp_trusted`,
        profileId: trustedProfile.id,
        capability: "MCP",
        decision: "ALLOW",
        resourceScopeCondition: "REMOTE_MCP",
        channelCondition: Channel.PRIVATE_CHAT,
        requiredPlanTier: CapabilityPlanTier.PASS,
        priority: 165,
        requiresPaidPlan: true,
        requiresHumanApproval: false,
      },
    ],
  });
}

function mapGroupActivationToDb(value: (typeof demoRepresentative.groupActivation)): GroupActivation {
  switch (value) {
    case "mention_only":
      return GroupActivation.MENTION_ONLY;
    case "always":
      return GroupActivation.ALWAYS;
    case "reply_or_mention":
    default:
      return GroupActivation.REPLY_OR_MENTION;
  }
}

function mapPricingPlanType(value: string): PricingPlanType {
  switch (value) {
    case "pass":
      return PricingPlanType.PASS;
    case "deep_help":
      return PricingPlanType.DEEP_HELP;
    case "sponsor":
      return PricingPlanType.SPONSOR;
    case "free":
    default:
      return PricingPlanType.FREE;
  }
}

function mapSkillPackSourceToDb(value: string): SkillPackSource {
  switch (value) {
    case "clawhub":
      return SkillPackSource.CLAWHUB;
    case "owner_upload":
      return SkillPackSource.OWNER_UPLOAD;
    case "builtin":
    default:
      return SkillPackSource.BUILTIN;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  seedDatabase()
    .then(async () => {
      await prisma.$disconnect();
      console.log(`Seeded representative ${demoRepresentative.slug}.`);
    })
    .catch(async (error: unknown) => {
      console.error("Failed to seed database.", error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
