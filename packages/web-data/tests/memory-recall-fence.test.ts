import {
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedMemoryManagedUserId,
  buildGovernedRepresentativeExperienceVersionUri,
} from "@delegate/openviking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMocks, mockPrisma } = vi.hoisted(() => ({
  clientMocks: {
    construct: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
  },
  mockPrisma: {
    conversation: { findFirst: vi.fn() },
    conversationEpisode: { findFirst: vi.fn() },
    representativeMemoryPolicy: { findUnique: vi.fn() },
    governedMemory: { findMany: vi.fn() },
    conversationRecallTrace: { createMany: vi.fn() },
  },
}));

vi.mock("@delegate/openviking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@delegate/openviking")>();
  return {
    ...actual,
    OpenVikingClient: class {
      constructor(options: unknown) {
        clientMocks.construct(options);
      }

      search(input: unknown) {
        return clientMocks.search(input);
      }

      read(uri: string, limit: number) {
        return clientMocks.read(uri, limit);
      }
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: mockPrisma }));

import { recallRepresentativeContext } from "../src/openviking";

const representativeId = "rep-1";
const representativeSlug = "memory-rep";
const representativeVersionId = "version-1";
const contactId = "contact-a";
const namespaceKey = "memory-ns-1";
const contentHash = "sha256-memory-v1";

describe("governed memory recall fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENVIKING_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-openviking-model-key");
    mockPrisma.conversation.findFirst.mockResolvedValue(buildConversation());
    mockPrisma.conversationEpisode.findFirst.mockResolvedValue(buildEpisode());
    mockPrisma.representativeMemoryPolicy.findUnique.mockResolvedValue(null);
    mockPrisma.governedMemory.findMany.mockResolvedValue([]);
    mockPrisma.conversationRecallTrace.createMany.mockResolvedValue({ count: 1 });
    clientMocks.search.mockResolvedValue({ resources: [], memories: [] });
    clientMocks.read.mockResolvedValue("");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps pinned public knowledge available when the governed memory inventory query fails", async () => {
    enableMemoryPolicy();
    mockPrisma.governedMemory.findMany.mockRejectedValue(
      new Error("memory inventory storage unavailable"),
    );
    const publicUri =
      "viking://resources/delegate/reps/memory-rep/knowledge/asset-1.md/asset-1.md";
    clientMocks.search.mockImplementation(async ({ targetUri }: { targetUri: string }) => ({
      resources: targetUri.includes("/knowledge/")
        ? [remoteMatch(publicUri, "resource", "Remote public abstract")]
        : [],
      memories: [],
    }));
    clientMocks.read.mockResolvedValue("# Approved public answer\nTrusted published body.");

    const recalled = await recall("web");

    expect(recalled.items).toEqual([
      expect.objectContaining({
        uri: publicUri,
        content: expect.stringContaining("Trusted published body"),
        internalSource: { sourceKind: "PUBLIC_KNOWLEDGE" },
      }),
    ]);
    expect(mockPrisma.governedMemory.findMany).toHaveBeenCalled();
    expect(mockPrisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceChannel: "web" }),
      }),
    );
  });

  it("returns authorized context when best-effort recall diagnostics persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publicUri =
      "viking://resources/delegate/reps/memory-rep/knowledge/asset-1.md/asset-1.md";
    clientMocks.search.mockImplementation(async ({ targetUri }: { targetUri: string }) => ({
      resources: targetUri.includes("/knowledge/")
        ? [remoteMatch(publicUri, "resource", "Published diagnostic-independent fact")]
        : [],
      memories: [],
    }));
    clientMocks.read.mockResolvedValue("# Published source\nDiagnostic-independent fact.");
    mockPrisma.conversationRecallTrace.createMany.mockRejectedValue(
      new Error("diagnostics database unavailable"),
    );

    const recalled = await recall("web");

    expect(recalled.items).toEqual([
      expect.objectContaining({ uri: publicUri }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Recall diagnostics persistence failed; authorized context will continue.",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("remembered preference");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("viking://");
    warn.mockRestore();
  });

  it.each([
    ["missing policy", null, "web"],
    ["long-term memory disabled", { longTermMemoryEnabled: false }, "web"],
    ["contact memory disabled", { contactMemoryEnabled: false }, "web"],
    ["web recall disabled", { webRecallEnabled: false }, "web"],
    ["matrix recall disabled", { matrixRecallEnabled: false }, "matrix"],
    ["telegram recall disabled", { telegramRecallEnabled: false }, "telegram"],
    ["memory provider is not OpenViking", { provider: "another-provider" }, "web"],
  ] as const)("fails long-term memory closed when %s", async (_label, override, sourceChannel) => {
    if (override) enableMemoryPolicy(override);
    const recalled = await recall(sourceChannel, ["CONTACT_MEMORY"]);

    expect(recalled).toEqual({ items: [], citations: [] });
    expect(mockPrisma.governedMemory.findMany).not.toHaveBeenCalled();
    expect(clientMocks.search).not.toHaveBeenCalled();
  });

  it.each(["web", "matrix", "telegram"] as const)(
    "isolates contact memory by contact and %s source channel and hydrates only from Postgres",
    async (sourceChannel) => {
      enableMemoryPolicy();
      const matching = buildContactMemory({
        contactId,
        sourceChannel,
        memoryId: `memory-${sourceChannel}`,
        versionId: `memory-version-${sourceChannel}`,
      });
      const otherContact = buildContactMemory({
        contactId: "contact-b",
        sourceChannel,
        memoryId: `memory-b-${sourceChannel}`,
        versionId: `memory-b-version-${sourceChannel}`,
      });
      const otherChannel = buildContactMemory({
        contactId,
        sourceChannel: sourceChannel === "web" ? "matrix" : "web",
        memoryId: `memory-other-channel-${sourceChannel}`,
        versionId: `memory-other-channel-version-${sourceChannel}`,
      });
      mockPrisma.governedMemory.findMany.mockResolvedValue([
        matching.record,
        otherContact.record,
        otherChannel.record,
      ]);
      clientMocks.search.mockImplementation(async () => ({
        resources: [],
        memories: [
          remoteMatch(matching.uri, "memory", "REMOTE BODY MUST NOT BE TRUSTED"),
          remoteMatch(`${matching.uri}/spoofed-child.md`, "memory", "spoof"),
          remoteMatch(otherContact.uri, "memory", "other contact"),
          remoteMatch(otherChannel.uri, "memory", "other channel"),
        ],
      }));
      clientMocks.read.mockResolvedValue("REMOTE POISONED LONG-TERM MEMORY");

      const recalled = await recall(sourceChannel);

      expect(recalled.items).toHaveLength(1);
      expect(recalled.items[0]).toMatchObject({
        uri: matching.uri,
        abstract: "Postgres summary",
        content: "Postgres safe memory text",
        internalSource: {
          sourceKind: "CONTACT_MEMORY",
          contentHash,
          memoryVersionId: matching.versionId,
          projectionItemId: `projection-${matching.versionId}`,
        },
      });
      expect(recalled.citations).toEqual([{
        title: "Remembered preference",
        excerpt: "Postgres summary",
        score: 0.95,
      }]);
      expect(recalled.citations[0]).not.toHaveProperty("uri");
      expect(recalled.citations[0]).not.toHaveProperty("layer");
      expect(recalled.citations[0]).not.toHaveProperty("memoryVersionId");
      expect(recalled.citations[0]).not.toHaveProperty("projectionItemId");
      expect(clientMocks.read).not.toHaveBeenCalled();
      expect(mockPrisma.conversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sourceChannel }),
        }),
      );
      expect(clientMocks.search).toHaveBeenCalledWith(expect.objectContaining({
        targetUri: buildGovernedContactChannelMemoryRootUri({
          namespaceKey,
          contactId,
          channel: sourceChannel,
        }),
      }));
      expect(clientMocks.construct).toHaveBeenCalledWith(expect.objectContaining({
        userId: buildGovernedMemoryManagedUserId(namespaceKey),
      }));
      expect(clientMocks.construct).toHaveBeenCalledWith(expect.objectContaining({
        userId: `rep-${representativeSlug}`,
      }));
      expect(mockPrisma.governedMemory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            representativeId,
            OR: expect.arrayContaining([
              expect.objectContaining({
                contactId,
                sourceChannel: sourceChannel.toUpperCase(),
              }),
            ]),
          }),
        }),
      );
    },
  );

  it("uses independent public and memory search limits and thresholds", async () => {
    enableMemoryPolicy({ recallLimit: 1, recallScoreThreshold: 0.8 });
    const high = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-high",
      versionId: "memory-version-high",
    });
    const second = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-second",
      versionId: "memory-version-second",
    });
    const belowThreshold = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-low",
      versionId: "memory-version-low",
    });
    mockPrisma.governedMemory.findMany.mockResolvedValue([
      high.record,
      second.record,
      belowThreshold.record,
    ]);
    const publicUri =
      "viking://resources/delegate/reps/memory-rep/knowledge/asset-1.md/asset-1.md";
    clientMocks.search.mockImplementation(async ({
      targetUri,
    }: {
      targetUri: string;
      limit: number;
      scoreThreshold: number;
    }) => {
      if (targetUri.includes("/knowledge/")) {
        return {
          resources: [{ ...remoteMatch(publicUri, "resource", "Public low-score fact"), score: 0.2 }],
          memories: [],
        };
      }
      if (targetUri.includes("/channels/web/")) {
        return {
          resources: [],
          memories: [
            { ...remoteMatch(high.uri, "memory", "remote high"), score: 0.95 },
            { ...remoteMatch(second.uri, "memory", "remote second"), score: 0.9 },
            { ...remoteMatch(belowThreshold.uri, "memory", "remote low"), score: 0.7 },
          ],
        };
      }
      return { resources: [], memories: [] };
    });
    clientMocks.read.mockResolvedValue("# Public source\nPublic low-score fact.");

    const recalled = await recall("web");

    expect(recalled.items.map((item) => item.uri)).toEqual([high.uri, publicUri]);
    expect(recalled.items.map((item) => item.uri)).not.toContain(second.uri);
    expect(recalled.items.map((item) => item.uri)).not.toContain(belowThreshold.uri);
    expect(clientMocks.search).toHaveBeenCalledWith(expect.objectContaining({
      targetUri: expect.stringContaining("/channels/web/"),
      limit: 1,
      scoreThreshold: 0.8,
    }));
    expect(clientMocks.search).toHaveBeenCalledWith(expect.objectContaining({
      targetUri: expect.stringContaining("/knowledge/"),
      limit: 10,
      scoreThreshold: 0.01,
    }));
  });

  it("keeps public knowledge available when the configured memory provider is unsupported", async () => {
    enableMemoryPolicy({ provider: "another-provider" });
    const publicUri =
      "viking://resources/delegate/reps/memory-rep/knowledge/asset-1.md/asset-1.md";
    clientMocks.search.mockImplementation(async ({ targetUri }: { targetUri: string }) => ({
      resources: targetUri.includes("/knowledge/")
        ? [remoteMatch(publicUri, "resource", "Published provider-independent fact")]
        : [],
      memories: [],
    }));
    clientMocks.read.mockResolvedValue("# Published source\nProvider-independent fact.");

    const recalled = await recall("web");

    expect(recalled.items).toEqual([
      expect.objectContaining({
        uri: publicUri,
        internalSource: { sourceKind: "PUBLIC_KNOWLEDGE" },
      }),
    ]);
    expect(mockPrisma.governedMemory.findMany).not.toHaveBeenCalled();
    expect(clientMocks.search).not.toHaveBeenCalledWith(expect.objectContaining({
      targetUri: expect.stringContaining("/channels/web/"),
    }));
  });

  it.each([
    ["inactive memory", { memory: { status: "SUPPRESSED" } }],
    ["different representative", { memory: { representativeId: "rep-2" } }],
    ["recall disabled", { memory: { recallDisabledAt: new Date("2026-08-03T01:00:00Z") } }],
    ["expired memory", { memory: { expiresAt: new Date("2020-01-01T00:00:00Z") } }],
    ["non-current version", { memory: { currentVersionId: "another-version" } }],
    ["purged version", { version: { purgedAt: new Date("2026-08-03T01:00:00Z") } }],
    ["missing approval", { version: { reviewDecisions: [] } }],
    ["latest review revoked", { version: { reviewDecisions: [{ id: "review-blocked", outcome: "BLOCKED" }] } }],
    ["unapproved source candidate", { version: { sourceCandidate: { status: "PENDING_REVIEW", contentPurgedAt: null } } }],
    ["different candidate contact", { version: { sourceCandidate: {
      representativeId,
      contactId: "contact-b",
      scope: "CONTACT_CHANNEL",
      scopeChannel: "WEB",
      status: "APPROVED",
      contentPurgedAt: null,
      deidentifiedAt: null,
    } } }],
    ["staging projection", { projection: { lane: "STAGING" } }],
    ["inactive projection", { projection: { status: "STAGED" } }],
    ["projection hash mismatch", { projection: { contentHash: "sha256-other" } }],
    ["projection URI prefix spoof", { projectionUriSuffix: "/spoofed-child.md" }],
    ["deleted projection", { projection: { deletedAt: new Date("2026-08-03T01:00:00Z") } }],
  ] as const)("rejects %s even if a remote result is returned", async (_label, mutation) => {
    enableMemoryPolicy();
    const memory = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-invalid",
      versionId: "memory-version-invalid",
      mutation,
    });
    mockPrisma.governedMemory.findMany.mockResolvedValue([memory.record]);
    clientMocks.search.mockResolvedValue({
      resources: [],
      memories: [remoteMatch(memory.expectedUri, "memory", "remote body")],
    });

    await expect(recall("web")).resolves.toEqual({ items: [], citations: [] });
    expect(clientMocks.read).not.toHaveBeenCalled();
  });

  it("allows only deidentified representative experience with no contact or channel scope", async () => {
    enableMemoryPolicy();
    const valid = buildRepresentativeExperience({
      memoryId: "experience-valid",
      versionId: "experience-version-valid",
    });
    const identified = buildRepresentativeExperience({
      memoryId: "experience-identified",
      versionId: "experience-version-identified",
      deidentifiedAt: null,
    });
    const contactScoped = buildRepresentativeExperience({
      memoryId: "experience-contact",
      versionId: "experience-version-contact",
      contactId,
      sourceChannel: "WEB",
    });
    mockPrisma.governedMemory.findMany.mockResolvedValue([
      valid.record,
      identified.record,
      contactScoped.record,
    ]);
    clientMocks.search.mockResolvedValue({
      resources: [],
      memories: [
        remoteMatch(valid.uri, "memory", "remote valid"),
        remoteMatch(identified.uri, "memory", "remote identified"),
        remoteMatch(contactScoped.uri, "memory", "remote contact"),
      ],
    });

    const recalled = await recall("web", ["REPRESENTATIVE_EXPERIENCE"]);

    expect(recalled.items).toHaveLength(1);
    expect(recalled.items[0]).toMatchObject({
      uri: valid.uri,
      content: "Deidentified Postgres experience",
      internalSource: {
        sourceKind: "REPRESENTATIVE_EXPERIENCE",
        memoryVersionId: valid.versionId,
      },
    });
    expect(clientMocks.read).not.toHaveBeenCalled();
  });

  it("drops a memory whose Postgres authorization changes after search", async () => {
    enableMemoryPolicy();
    const memory = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-state-flip",
      versionId: "memory-version-state-flip",
    });
    mockPrisma.governedMemory.findMany
      .mockResolvedValueOnce([memory.record])
      .mockResolvedValueOnce([{
        ...memory.record,
        status: "DELETE_PENDING",
        recallDisabledAt: new Date("2026-08-03T02:00:00Z"),
      }]);
    clientMocks.search.mockResolvedValue({
      resources: [],
      memories: [remoteMatch(memory.uri, "memory", "remote body")],
    });

    await expect(recall("web")).resolves.toEqual({ items: [], citations: [] });
    expect(mockPrisma.governedMemory.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.conversationRecallTrace.createMany).not.toHaveBeenCalled();
    expect(clientMocks.read).not.toHaveBeenCalled();
  });

  it("reapplies a stricter memory limit and threshold changed during hydration", async () => {
    mockPrisma.representativeMemoryPolicy.findUnique
      .mockResolvedValueOnce(buildMemoryPolicy({
        recallLimit: 2,
        recallScoreThreshold: 0.1,
      }))
      .mockResolvedValueOnce(buildMemoryPolicy({
        recallLimit: 1,
        recallScoreThreshold: 0.9,
      }));
    const high = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-revalidated-high",
      versionId: "memory-version-revalidated-high",
    });
    const second = buildContactMemory({
      contactId,
      sourceChannel: "web",
      memoryId: "memory-revalidated-second",
      versionId: "memory-version-revalidated-second",
    });
    mockPrisma.governedMemory.findMany.mockResolvedValue([high.record, second.record]);
    clientMocks.search.mockResolvedValue({
      resources: [],
      memories: [
        { ...remoteMatch(high.uri, "memory", "remote high"), score: 0.95 },
        { ...remoteMatch(second.uri, "memory", "remote second"), score: 0.92 },
      ],
    });

    const recalled = await recall("web", ["CONTACT_MEMORY"]);

    expect(recalled.items.map((item) => item.uri)).toEqual([high.uri]);
    expect(clientMocks.search).toHaveBeenCalledWith(expect.objectContaining({
      limit: 2,
      scoreThreshold: 0.1,
    }));
  });

  it("fails closed for unknown channels without silently falling back to web", async () => {
    await expect(recallRepresentativeContext({
      representativeSlug,
      conversationId: "conversation-1",
      contactId,
      sourceChannel: "sms" as never,
      queryText: "remembered preference",
    })).resolves.toEqual({ items: [], citations: [] });

    expect(mockPrisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(clientMocks.search).not.toHaveBeenCalled();
  });
});

function recall(
  sourceChannel: "web" | "matrix" | "telegram",
  allowedSourceKinds?: readonly (
    "PUBLIC_KNOWLEDGE" | "CONTACT_MEMORY" | "REPRESENTATIVE_EXPERIENCE"
  )[],
) {
  return recallRepresentativeContext({
    representativeSlug,
    conversationId: "conversation-1",
    contactId,
    sourceChannel,
    queryText: "remembered preference",
    ...(allowedSourceKinds ? { allowedSourceKinds } : {}),
  });
}

function enableMemoryPolicy(overrides: Record<string, unknown> = {}) {
  mockPrisma.representativeMemoryPolicy.findUnique.mockResolvedValue(
    buildMemoryPolicy(overrides),
  );
}

function buildMemoryPolicy(overrides: Record<string, unknown> = {}) {
  return {
    namespaceKey,
    longTermMemoryEnabled: true,
    contactMemoryEnabled: true,
    representativeExperienceEnabled: true,
    webRecallEnabled: true,
    matrixRecallEnabled: true,
    telegramRecallEnabled: true,
    provider: "openviking",
    recallLimit: 6,
    recallScoreThreshold: 0.01,
    ...overrides,
  };
}

function buildConversation() {
  return {
    id: "conversation-1",
    activeEpisodeId: "episode-1",
    representative: {
      id: representativeId,
      slug: representativeSlug,
      lifecycleState: "PUBLISHED",
      openvikingEnabled: true,
      openvikingAutoRecall: true,
      openvikingAgentId: "agent-memory-rep",
      openvikingRecallLimit: 10,
      openvikingRecallScoreThreshold: 0.01,
      knowledgeAssetLinks: [{
        assetId: "asset-1",
        enabled: true,
        reviewStatus: "APPROVED",
        asset: {
          status: "READY",
          archivedAt: null,
          checksum: "sha256-asset-1",
          processingVersion: 1,
        },
      }],
    },
  };
}

function buildEpisode() {
  return {
    representativeVersion: {
      id: representativeVersionId,
      representativeId,
      status: "PUBLISHED",
      snapshot: {
        identity: {
          displayName: "Memory Representative",
          roleSummary: "Test representative",
          tone: "clear",
          languages: ["en"],
        },
        publicMode: true,
        humanInLoop: true,
        groupActivation: "mention",
        conversation: {
          freeReplyLimit: 3,
          freeScope: [],
          paywalledIntents: [],
          handoffWindowHours: 24,
          handoffPrompt: "Escalate",
        },
        governance: { allowedSkills: [] },
        knowledge: null,
        knowledgeAssets: [{
          assetId: "asset-1",
          checksum: "sha256-asset-1",
          processingVersion: 1,
        }],
        pricing: [],
      },
    },
  };
}

function remoteMatch(
  uri: string,
  contextType: "resource" | "memory",
  abstract: string,
) {
  return {
    uri,
    context_type: contextType,
    is_leaf: true,
    abstract,
    score: 0.95,
  };
}

type ContactMemoryMutation = {
  memory?: Record<string, unknown>;
  version?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  projectionUriSuffix?: string;
};

function buildContactMemory(params: {
  contactId: string;
  sourceChannel: "web" | "matrix" | "telegram";
  memoryId: string;
  versionId: string;
  mutation?: ContactMemoryMutation;
}) {
  const expectedUri = buildGovernedContactChannelMemoryVersionUri({
    namespaceKey,
    contactId: params.contactId,
    channel: params.sourceChannel,
    memoryId: params.memoryId,
    memoryVersionId: params.versionId,
  });
  const projection = {
    id: `projection-${params.versionId}`,
    representativeId,
    provider: "openviking",
    lane: "RECALL",
    status: "ACTIVE",
    contentHash,
    remoteUri: `${expectedUri}${params.mutation?.projectionUriSuffix ?? ""}`,
    projectedAt: new Date("2026-08-03T00:00:00Z"),
    deletedAt: null,
    ...params.mutation?.projection,
  };
  const version = {
    id: params.versionId,
    representativeId,
    scope: "CONTACT_CHANNEL",
    safeText: "Postgres safe memory text",
    summary: "Postgres summary",
    contentHash,
    purgedAt: null,
    deidentifiedAt: null,
    deidentificationMethod: null,
    sourceCandidate: {
      representativeId,
      contactId: params.contactId,
      scope: "CONTACT_CHANNEL",
      scopeChannel: params.sourceChannel.toUpperCase(),
      status: "APPROVED",
      contentPurgedAt: null,
      deidentifiedAt: null,
    },
    reviewDecisions: [{
      id: `review-${params.versionId}`,
      representativeId,
      outcome: "APPROVED",
    }],
    projectionItems: [projection],
    ...params.mutation?.version,
  };
  return {
    uri: expectedUri,
    expectedUri,
    versionId: params.versionId,
    record: {
      id: params.memoryId,
      representativeId,
      scope: "CONTACT_CHANNEL",
      contactId: params.contactId,
      sourceChannel: params.sourceChannel.toUpperCase(),
      category: "CONTACT_PREFERENCE",
      status: "ACTIVE",
      recallDisabledAt: null,
      expiresAt: null,
      currentVersionId: params.versionId,
      currentVersion: version,
      ...params.mutation?.memory,
    },
  };
}

function buildRepresentativeExperience(params: {
  memoryId: string;
  versionId: string;
  deidentifiedAt?: Date | null;
  contactId?: string | null;
  sourceChannel?: "WEB" | "MATRIX" | "TELEGRAM" | null;
}) {
  const uri = buildGovernedRepresentativeExperienceVersionUri({
    namespaceKey,
    memoryId: params.memoryId,
    memoryVersionId: params.versionId,
  });
  return {
    uri,
    versionId: params.versionId,
    record: {
      id: params.memoryId,
      representativeId,
      scope: "REPRESENTATIVE",
      contactId: params.contactId ?? null,
      sourceChannel: params.sourceChannel ?? null,
      category: "REPRESENTATIVE_RESPONSE_PATTERN",
      status: "ACTIVE",
      recallDisabledAt: null,
      expiresAt: null,
      currentVersionId: params.versionId,
      currentVersion: {
        id: params.versionId,
        representativeId,
        scope: "REPRESENTATIVE",
        safeText: "Deidentified Postgres experience",
        summary: "Deidentified representative pattern",
        contentHash,
        purgedAt: null,
        deidentifiedAt: params.deidentifiedAt === undefined
          ? new Date("2026-08-03T00:00:00Z")
          : params.deidentifiedAt,
        deidentificationMethod: "entity-redaction-v1",
        sourceCandidate: {
          representativeId,
          contactId: null,
          scope: "REPRESENTATIVE",
          scopeChannel: null,
          status: "APPROVED",
          contentPurgedAt: null,
          deidentifiedAt: params.deidentifiedAt === undefined
            ? new Date("2026-08-03T00:00:00Z")
            : params.deidentifiedAt,
        },
        reviewDecisions: [{
          id: `review-${params.versionId}`,
          representativeId,
          outcome: "APPROVED",
        }],
        projectionItems: [{
          id: `projection-${params.versionId}`,
          representativeId,
          provider: "openviking",
          lane: "RECALL",
          status: "ACTIVE",
          contentHash,
          remoteUri: uri,
          projectedAt: new Date("2026-08-03T00:00:00Z"),
          deletedAt: null,
        }],
      },
    },
  };
}
