import { demoRepresentative } from "@delegate/domain";
import {
  AudienceRole,
  CapabilityPlanTier,
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  ComputeFilesystemMode,
  ComputeNetworkMode,
  Channel,
  ContactStage,
  CreatorVerificationStatus,
  EventType,
  GroupActivation,
  HandoffStatus,
  InvoiceStatus,
  OwnerIdentityLinkProvider,
  Prisma,
  PolicyDecision,
  PricingPlanType,
  PrismaClient,
  RepresentativeChannelKind,
  RepresentativeClaimStatus,
  RepresentativeLifecycleState,
  SkillPackSource,
} from "@prisma/client";
import { pathToFileURL } from "node:url";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

const prisma = new PrismaClient();

const DEMO_OWNER_ID = "owner_lin_demo";
const DEMO_OWNER_DEV_AUTH_SUBJECT = "delegate-dev-owner";
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

export async function seedDatabase(
  client: PrismaClient = prisma,
): Promise<"seeded" | "skipped"> {
  // Compose runs the seed command after every migration check. Seed data is an
  // initial workspace fixture, not a reset operation: once the demo
  // representative exists, preserve working drafts, active versions, wallet
  // balances, conversations, and every other piece of user-owned state.
  const existingWorkspace = await client.representative.findUnique({
    where: { slug: demoRepresentative.slug },
    select: { id: true, ownerId: true },
  });
  if (existingWorkspace) {
    if (
      existingWorkspace.id === DEMO_REPRESENTATIVE_ID
      && existingWorkspace.ownerId === DEMO_OWNER_ID
    ) {
      await reconcileLegacyDemoOwnerDevIssuer(client, existingWorkspace.ownerId);
    }
    console.log(`Seed skipped: representative "${demoRepresentative.slug}" already exists.`);
    return "skipped";
  }

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

    const owner = await tx.owner.upsert({
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

    const devAuthIssuer = "https://local-auth.delegate.invalid/oidc";
    const exactDevAuthLink = await tx.ownerIdentityLink.findFirst({
      where: {
        provider: OwnerIdentityLinkProvider.LOGTO,
        issuer: devAuthIssuer,
        providerSubject: DEMO_OWNER_DEV_AUTH_SUBJECT,
      },
      select: { id: true, ownerId: true, issuer: true, metadata: true },
    });
    const existingDevAuthLink =
      exactDevAuthLink ??
      await tx.ownerIdentityLink.findUnique({
        where: {
          provider_providerSubject: {
            provider: OwnerIdentityLinkProvider.LOGTO,
            providerSubject: DEMO_OWNER_DEV_AUTH_SUBJECT,
          },
        },
        select: { id: true, ownerId: true, issuer: true, metadata: true },
      });
    if (existingDevAuthLink && existingDevAuthLink.ownerId !== owner.id) {
      throw new Error(
        `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" already belongs to another owner.`,
      );
    }
    if (
      existingDevAuthLink?.issuer
      && existingDevAuthLink.issuer !== devAuthIssuer
    ) {
      throw new Error(
        `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" belongs to issuer "${existingDevAuthLink.issuer}".`,
      );
    }
    if (
      !exactDevAuthLink
      && existingDevAuthLink
      && !hasApprovedSeedIssuerEvidence(
        existingDevAuthLink.metadata,
        devAuthIssuer,
      )
    ) {
      throw new Error(
        `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" lacks approved local fixture issuer evidence.`,
      );
    }
    const devAuthIdentityData = {
      issuer: devAuthIssuer,
      email: "creator@delegate.local",
      verifiedAt: now,
      emailVerifiedAt: now,
      metadata: {
        issuer: devAuthIssuer,
        mode: "development",
        actor: "owner",
        fixture: "prisma-seed",
      },
    };
    if (existingDevAuthLink) {
      await tx.ownerIdentityLink.update({
        where: { id: existingDevAuthLink.id },
        data: devAuthIdentityData,
      });
    } else {
      await tx.ownerIdentityLink.create({
        data: {
          id: "owner_identity_link_dev_demo",
          ownerId: owner.id,
          provider: OwnerIdentityLinkProvider.LOGTO,
          providerSubject: DEMO_OWNER_DEV_AUTH_SUBJECT,
          ...devAuthIdentityData,
        },
      });
    }

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

      const workspaceInstall = pack.installStatus === "available" ? null : await tx.workspaceSkillInstall.upsert({
        where: {
          ownerId_skillPackId: {
            ownerId: owner.id,
            skillPackId: skillPack.id,
          },
        },
        create: {
          id: `workspace_skill_${skillPack.id}`,
          ownerId: owner.id,
          skillPackId: skillPack.id,
          status:
            pack.installStatus === "update_available" ? "UPDATE_AVAILABLE" : "INSTALLED",
          reviewStatus: "APPROVED",
          installedVersion: pack.version ?? null,
          installedBy: owner.id,
          installedAt: now,
        },
        update: {
          status:
            pack.installStatus === "update_available" ? "UPDATE_AVAILABLE" : "INSTALLED",
          installedVersion: pack.version ?? null,
          reviewStatus: "APPROVED",
        },
      });

      if (workspaceInstall) {
        await tx.workspaceSkillRelease.upsert({
          where: {
            installId_version: {
              installId: workspaceInstall.id,
              version: pack.version ?? "unversioned",
            },
          },
          create: {
            id: `workspace_skill_release_${skillPack.id}_${pack.version ?? "unversioned"}`,
            installId: workspaceInstall.id,
            version: pack.version ?? "unversioned",
            status: "INSTALLED",
            displayName: pack.displayName,
            summary: pack.summary,
            sourceUrl: pack.sourceUrl ?? null,
            ownerHandle: pack.ownerHandle ?? null,
            verificationTier: pack.verificationTier ?? null,
            capabilityTags: pack.capabilityTags,
            executesCode: pack.executesCode,
            reviewedBy: owner.id,
            reviewedAt: now,
            adoptedAt: now,
          },
          update: {},
        });
      }

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
          workspaceInstallId: workspaceInstall?.id ?? null,
          enabled: pack.enabled,
          installStatus: pack.installStatus,
          installedVersion: pack.version ?? null,
          installedAt: pack.installStatus === "available" ? null : now,
        },
        update: {
          workspaceInstallId: workspaceInstall?.id ?? null,
          enabled: pack.enabled,
          installStatus: pack.installStatus,
          installedVersion: pack.version ?? null,
          installedAt: pack.installStatus === "available" ? null : now,
        },
      });
    }

    await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId: representative.id,
          kind: RepresentativeChannelKind.WEB,
        },
      },
      create: {
        id: `rep_channel_web_${representative.id}`,
        representativeId: representative.id,
        kind: RepresentativeChannelKind.WEB,
        transport: ChannelTransport.WEB,
        sourceProvider: ChannelSourceProvider.WEB,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        externalUserId: `/reps/${representative.slug}`,
        displayName: representative.displayName,
        configuration: { publicMode: true, source: "seed" },
      },
      update: {
        externalUserId: `/reps/${representative.slug}`,
        status: "CONNECTED",
        transport: ChannelTransport.WEB,
        sourceProvider: ChannelSourceProvider.WEB,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        displayName: representative.displayName,
        configuration: { publicMode: true, source: "seed" },
      },
    });

    await tx.representativeChannelBinding.upsert({
      where: {
        representativeId_kind: {
          representativeId: representative.id,
          kind: RepresentativeChannelKind.TELEGRAM,
        },
      },
      create: {
        id: `rep_channel_telegram_${representative.id}`,
        representativeId: representative.id,
        kind: RepresentativeChannelKind.TELEGRAM,
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        externalUserId: `telegram:${representative.slug}`,
        displayName: representative.displayName,
        configuration: { source: "seed" },
      },
      update: {
        status: "CONNECTED",
        transport: ChannelTransport.TELEGRAM,
        sourceProvider: ChannelSourceProvider.TELEGRAM,
        desiredState: ChannelDesiredState.ACTIVE,
        healthStatus: ChannelHealthStatus.HEALTHY,
        displayName: representative.displayName,
        configuration: { source: "seed" },
      },
    });

    const representativeVersion = await tx.representativeVersion.upsert({
      where: {
        representativeId_versionNumber: {
          representativeId: representative.id,
          versionNumber: 1,
        },
      },
      create: {
        id: `rep_version_${representative.id}_1`,
        representativeId: representative.id,
        versionNumber: 1,
        snapshot: buildSeedRepresentativeVersionSnapshot(),
        changeSummary: "Initial seeded representative configuration.",
        publishedBy: "system:seed",
      },
      update: {
        snapshot: buildSeedRepresentativeVersionSnapshot(),
        changeSummary: "Initial seeded representative configuration.",
        publishedBy: "system:seed",
      },
    });

    await tx.representative.update({
      where: { id: representative.id },
      data: {
        lifecycleState: RepresentativeLifecycleState.PUBLISHED,
        activeVersionId: representativeVersion.id,
      },
    });

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
          channelUserId: contact.telegramUserId,
          externalUserId: contact.telegramUserId,
          username: contact.username ?? null,
          displayName: contact.displayName,
          role: contact.role,
          stage: contact.stage,
          isPaid: contact.isPaid,
          source: contact.source,
          sourceChannel: "telegram",
          lastSeenAt: now,
        },
        update: {
          username: contact.username ?? null,
          channelUserId: contact.telegramUserId,
          externalUserId: contact.telegramUserId,
          displayName: contact.displayName,
          role: contact.role,
          stage: contact.stage,
          isPaid: contact.isPaid,
          source: contact.source,
          sourceChannel: "telegram",
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
          channelThreadId: conversation.telegramChatId,
          externalConversationId: conversation.telegramChatId,
          channel: conversation.channel,
          sourceChannel: "telegram",
          state: conversation.state,
          freeRepliesUsed: conversation.freeRepliesUsed,
          passUnlockedAt: conversation.passUnlockedAt,
          deepHelpUnlockedAt: conversation.deepHelpUnlockedAt,
          createdAt: conversation.createdAt,
          lastMessageAt: conversation.lastMessageAt,
        },
        update: {
          contactId,
          channelThreadId: conversation.telegramChatId,
          externalConversationId: conversation.telegramChatId,
          channel: conversation.channel,
          sourceChannel: "telegram",
          state: conversation.state,
          freeRepliesUsed: conversation.freeRepliesUsed,
          passUnlockedAt: conversation.passUnlockedAt,
          deepHelpUnlockedAt: conversation.deepHelpUnlockedAt,
          lastMessageAt: conversation.lastMessageAt,
        },
      });

      conversationIdsByFixtureKey.set(conversation.key, upsertedConversation.id);

      const episodeId = `episode_${conversation.key}_1`;
      const episode = await tx.conversationEpisode.upsert({
        where: {
          conversationId_sequence: {
            conversationId: upsertedConversation.id,
            sequence: 1,
          },
        },
        create: {
          id: episodeId,
          conversationId: upsertedConversation.id,
          representativeVersionId: representativeVersion.id,
          sequence: 1,
          startedAt: conversation.createdAt,
        },
        update: {
          representativeVersionId: representativeVersion.id,
          status: "ACTIVE",
        },
      });
      const telegramRepresentativeBinding = await tx.representativeChannelBinding.findUniqueOrThrow({
        where: {
          representativeId_kind: {
            representativeId: representative.id,
            kind: RepresentativeChannelKind.TELEGRAM,
          },
        },
      });
      await tx.conversationChannelBinding.deleteMany({
        where: { conversationId: upsertedConversation.id },
      });
      await tx.conversationChannelBinding.create({
        data: {
          id: `channel_${conversation.key}_telegram`,
          conversationId: upsertedConversation.id,
          representativeBindingId: telegramRepresentativeBinding.id,
          kind: RepresentativeChannelKind.TELEGRAM,
          transport: ChannelTransport.TELEGRAM,
          sourceProvider: ChannelSourceProvider.TELEGRAM,
          bindingKey: `TELEGRAM:${representative.id}:${conversation.telegramChatId}:`,
          externalConversationId: conversation.telegramChatId,
          metadata: { source: "seed" },
        },
      });
      await tx.conversationParticipant.upsert({
        where: {
          conversationId_kind_participantId: {
            conversationId: upsertedConversation.id,
            kind: "AUDIENCE",
            participantId: contactId,
          },
        },
        create: {
          id: `participant_${conversation.key}_audience`,
          conversationId: upsertedConversation.id,
          kind: "AUDIENCE",
          participantId: contactId,
          joinedAt: conversation.createdAt,
          metadata: { source: "seed" },
        },
        update: { metadata: { source: "seed" } },
      });
      await tx.conversationParticipant.upsert({
        where: {
          conversationId_kind_participantId: {
            conversationId: upsertedConversation.id,
            kind: "REPRESENTATIVE",
            participantId: representative.id,
          },
        },
        create: {
          id: `participant_${conversation.key}_representative`,
          conversationId: upsertedConversation.id,
          kind: "REPRESENTATIVE",
          participantId: representative.id,
          displayName: representative.displayName,
          joinedAt: conversation.createdAt,
          metadata: { source: "seed" },
        },
        update: {
          displayName: representative.displayName,
          metadata: { source: "seed" },
        },
      });
      await tx.conversation.update({
        where: { id: upsertedConversation.id },
        data: { activeEpisodeId: episode.id },
      });
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

    await tx.message.deleteMany({
      where: {
        conversationId: {
          in: conversations.map((conversation) => requireConversationId(conversation.key)),
        },
      },
    });

    const seededTurns = await tx.conversationTurn.findMany({
      where: {
        conversationId: {
          in: conversations.map((conversation) => requireConversationId(conversation.key)),
        },
      },
      include: { conversation: { include: { contact: true, representative: true, channelBindings: true } } },
    });
    await tx.message.createMany({
      data: seededTurns.map((turn) => ({
        id: `message_${turn.id}`,
        conversationId: turn.conversationId,
        episodeId: turn.conversation.activeEpisodeId,
        channelBindingId: turn.conversation.channelBindings[0]?.id ?? null,
        senderType: turn.direction === "inbound" ? "AUDIENCE" : "REPRESENTATIVE",
        senderId: turn.direction === "inbound" ? turn.conversation.contactId : turn.conversation.representativeId,
        senderDisplayName:
          turn.direction === "inbound"
            ? turn.conversation.contact.displayName
            : turn.conversation.representative.displayName,
        text: turn.messageText,
        content: { intent: turn.intent, summary: turn.summary, source: "seed" },
        deliveryStatus: "SENT",
        retentionExpiresAt: new Date(turn.createdAt.getTime() + 180 * 24 * 60 * 60 * 1000),
        createdAt: turn.createdAt,
      })),
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

  return "seeded";
}

async function reconcileLegacyDemoOwnerDevIssuer(
  client: Pick<PrismaClient, "ownerIdentityLink">,
  ownerId: string,
) {
  const issuer = "https://local-auth.delegate.invalid/oidc";
  const exactLink = await client.ownerIdentityLink.findFirst({
    where: {
      provider: OwnerIdentityLinkProvider.LOGTO,
      issuer,
      providerSubject: DEMO_OWNER_DEV_AUTH_SUBJECT,
    },
    select: { id: true },
  });
  if (exactLink) {
    return;
  }
  const legacyLink = await client.ownerIdentityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: OwnerIdentityLinkProvider.LOGTO,
        providerSubject: DEMO_OWNER_DEV_AUTH_SUBJECT,
      },
    },
    select: {
      id: true,
      ownerId: true,
      issuer: true,
      metadata: true,
    },
  });
  if (!legacyLink) {
    return;
  }
  if (legacyLink.ownerId !== ownerId) {
    throw new Error(
      `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" already belongs to another owner.`,
    );
  }
  if (legacyLink.issuer && legacyLink.issuer !== issuer) {
    throw new Error(
      `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" belongs to issuer "${legacyLink.issuer}".`,
    );
  }
  if (!hasApprovedSeedIssuerEvidence(legacyLink.metadata, issuer)) {
    throw new Error(
      `Seed development auth subject "${DEMO_OWNER_DEV_AUTH_SUBJECT}" lacks approved local fixture issuer evidence.`,
    );
  }
  await client.ownerIdentityLink.update({
    where: { id: legacyLink.id },
    data: {
      issuer,
      metadata: {
        ...toJsonRecord(legacyLink.metadata),
        issuer,
        mode: "development",
        actor: "owner",
        fixture: "prisma-seed",
      },
    },
  });
}

function toJsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  )
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function hasApprovedSeedIssuerEvidence(
  metadata: Prisma.JsonValue | null,
  issuer: string,
): boolean {
  const record = toJsonRecord(metadata);
  if (typeof record.issuer === "string") {
    return record.issuer.trim() === issuer;
  }
  return (
    record.mode === "development"
    && record.actor === "owner"
    && (
      record.fixture === "prisma-seed"
      || record.fixture === "local-compose-bootstrap"
    )
  );
}

function buildSeedRepresentativeVersionSnapshot(): Prisma.InputJsonObject {
  return {
    identity: {
      displayName: demoRepresentative.name,
      roleSummary: demoRepresentative.tagline,
      tone: demoRepresentative.tone,
      avatarUrl: null,
      languages: [...demoRepresentative.languages],
    },
    publicMode: true,
    humanInLoop: true,
    conversation: {
      freeReplyLimit: demoRepresentative.contract.freeReplyLimit,
      freeScope: [...demoRepresentative.contract.freeScope],
      paywalledIntents: [...demoRepresentative.contract.paywalledIntents],
      handoffWindowHours: demoRepresentative.contract.handoffWindowHours,
      handoffPrompt: demoRepresentative.handoffPrompt,
    },
    governance: {
      allowedSkills: [...demoRepresentative.skills],
      actionGate: { ...demoRepresentative.actionGate },
    },
    knowledge: {
      identitySummary: demoRepresentative.knowledgePack.identitySummary,
      faq: demoRepresentative.knowledgePack.faq.map((item) => ({ ...item })),
      materials: demoRepresentative.knowledgePack.materials.map((item) => ({ ...item })),
      policies: demoRepresentative.knowledgePack.policies.map((item) => ({ ...item })),
    },
    pricing: demoRepresentative.pricing.map((plan) => ({
      type: mapPricingPlanType(plan.tier),
      name: plan.name,
      starsAmount: plan.stars,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    })),
    skills: demoRepresentative.skillPacks.map((pack) => ({
      slug: pack.slug,
      version: pack.version ?? null,
      enabled: pack.enabled,
    })),
    channels: [
      { kind: "WEB", status: "CONNECTED", externalUserId: `/reps/${demoRepresentative.slug}` },
      { kind: "TELEGRAM", status: "CONNECTED", externalUserId: `telegram:${demoRepresentative.slug}` },
    ],
  };
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
    .then(async (result) => {
      await prisma.$disconnect();
      if (result === "seeded") {
        console.log(`Seeded representative ${demoRepresentative.slug}.`);
      }
    })
    .catch(async (error: unknown) => {
      console.error("Failed to seed database.", error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
