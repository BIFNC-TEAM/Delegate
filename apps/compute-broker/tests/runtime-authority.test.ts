import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRepresentativeRuntimeAuthoritySnapshot, mockPrisma } = vi.hoisted(() => ({
  mockGetRepresentativeRuntimeAuthoritySnapshot: vi.fn(),
  mockPrisma: {
    contact: { findFirst: vi.fn() },
    generationRun: { findFirst: vi.fn() },
    delegationTask: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    conversationEpisode: { findFirst: vi.fn() },
  },
}));

vi.mock("@delegate/web-data", () => ({
  getRepresentativeRuntimeAuthoritySnapshot:
    mockGetRepresentativeRuntimeAuthoritySnapshot,
}));

vi.mock("../src/prisma", () => ({
  prisma: mockPrisma,
}));

describe("compute runtime authority version pin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the version stored on the session without consulting mutable runtime context", async () => {
    const authority = {
      representativeVersionId: "version-created-with",
      compute: { enabled: true },
      delegation: { enabled: true },
      mcpBindings: [],
    };
    mockGetRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue(authority);
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        pinnedRepresentativeVersionId: "version-created-with",
        activeVersionId: "version-activated-later",
        conversationId: "conversation-that-may-roll-over",
        generationRunId: "run-1",
        delegationTaskId: "task-1",
      }),
    ).resolves.toBe(authority);

    expect(mockGetRepresentativeRuntimeAuthoritySnapshot).toHaveBeenCalledWith(
      "rep-one",
      "version-created-with",
    );
    expect(mockPrisma.generationRun.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.delegationTask.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.conversationEpisode.findFirst).not.toHaveBeenCalled();
  });

  it("fails closed for a legacy session without a stored version", async () => {
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        pinnedRepresentativeVersionId: null,
        activeVersionId: "version-activated-later",
      }),
    ).rejects.toThrow("compute_session_version_missing");

    expect(mockGetRepresentativeRuntimeAuthoritySnapshot).not.toHaveBeenCalled();
  });

  it("binds contact, conversation, generation run, and delegation task to one context", async () => {
    const authority = {
      representativeVersionId: "version-1",
      compute: { enabled: true },
      delegation: { enabled: true },
      mcpBindings: [],
    };
    mockPrisma.contact.findFirst.mockResolvedValue({ id: "contact-1" });
    mockPrisma.generationRun.findFirst.mockResolvedValue({
      representativeVersionId: "version-1",
    });
    mockPrisma.delegationTask.findFirst.mockResolvedValue({
      representativeVersionId: "version-1",
    });
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      activeEpisodeId: "episode-1",
    });
    mockPrisma.conversationEpisode.findFirst.mockResolvedValue({
      representativeVersionId: "version-1",
    });
    mockGetRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue(authority);
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        contactId: "contact-1",
        conversationId: "conversation-1",
        generationRunId: "run-1",
        delegationTaskId: "task-1",
      }),
    ).resolves.toBe(authority);

    expect(mockPrisma.generationRun.findFirst).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        delegationTaskId: "task-1",
        conversation: {
          representativeId: "rep-1",
          id: "conversation-1",
          contactId: "contact-1",
        },
      },
      select: { representativeVersionId: true },
    });
    expect(mockPrisma.delegationTask.findFirst).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        representativeId: "rep-1",
        contactId: "contact-1",
        originConversationId: "conversation-1",
        generationRuns: { some: { id: "run-1" } },
      },
      select: { representativeVersionId: true },
    });
  });

  it("rejects a generation run borrowed from another conversation", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: "contact-1" });
    mockPrisma.generationRun.findFirst.mockResolvedValue(null);
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        contactId: "contact-1",
        conversationId: "conversation-a",
        generationRunId: "run-from-conversation-b",
      }),
    ).rejects.toThrow("generation_run_context_mismatch");

    expect(mockPrisma.generationRun.findFirst).toHaveBeenCalledWith({
      where: {
        id: "run-from-conversation-b",
        delegationTaskId: null,
        conversation: {
          representativeId: "rep-1",
          id: "conversation-a",
          contactId: "contact-1",
        },
      },
      select: { representativeVersionId: true },
    });
    expect(mockGetRepresentativeRuntimeAuthoritySnapshot).not.toHaveBeenCalled();
  });

  it("rejects conversation and generation contexts that omit their audience boundary", async () => {
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        conversationId: "conversation-1",
      }),
    ).rejects.toThrow("conversation_contact_context_missing");
    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        generationRunId: "run-1",
      }),
    ).rejects.toThrow("generation_run_conversation_context_missing");
  });

  it("rejects runtime contexts pinned to different versions", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({ id: "contact-1" });
    mockPrisma.generationRun.findFirst.mockResolvedValue({
      representativeVersionId: "version-1",
    });
    mockPrisma.delegationTask.findFirst.mockResolvedValue({
      representativeVersionId: "version-2",
    });
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      activeEpisodeId: "episode-1",
    });
    mockPrisma.conversationEpisode.findFirst.mockResolvedValue({
      representativeVersionId: "version-1",
    });
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        contactId: "contact-1",
        conversationId: "conversation-1",
        generationRunId: "run-1",
        delegationTaskId: "task-1",
      }),
    ).rejects.toThrow("compute_runtime_version_context_mismatch");

    expect(mockGetRepresentativeRuntimeAuthoritySnapshot).not.toHaveBeenCalled();
  });

  it("uses the current active version only for contextless session creation", async () => {
    const authority = {
      representativeVersionId: "version-active-at-creation",
      compute: { enabled: true },
      delegation: { enabled: true },
      mcpBindings: [],
    };
    mockGetRepresentativeRuntimeAuthoritySnapshot.mockResolvedValue(authority);
    const { loadComputeRuntimeAuthority } = await import("../src/runtime-authority");

    await expect(
      loadComputeRuntimeAuthority({
        representativeId: "rep-1",
        representativeSlug: "rep-one",
        activeVersionId: "version-active-at-creation",
      }),
    ).resolves.toBe(authority);
    expect(mockGetRepresentativeRuntimeAuthoritySnapshot).toHaveBeenCalledWith(
      "rep-one",
      "version-active-at-creation",
    );
  });

  it("persists and consumes the session version pin at both runtime boundaries", () => {
    const sessionsSource = readFileSync(
      resolve(__dirname, "../src/sessions.ts"),
      "utf8",
    );
    const policySource = readFileSync(
      resolve(__dirname, "../src/policy.ts"),
      "utf8",
    );

    expect(sessionsSource).toContain(
      "representativeVersionId: runtimeAuthority.representativeVersionId",
    );
    expect(policySource).toContain(
      "pinnedRepresentativeVersionId: session.representativeVersionId",
    );
    expect(policySource).toContain(
      "expiresAt: { gt: effectiveExpiresAt }",
    );
  });

  it("does not guess an active version for ambiguous legacy sessions", () => {
    const migrationSource = readFileSync(
      resolve(
        __dirname,
        "../../../prisma/migrations/20260723214500_compute_session_runtime_version_pin/migration.sql",
      ),
      "utf8",
    );

    expect(migrationSource).toContain('"GenerationRun"');
    expect(migrationSource).toContain('"DelegationTask"');
    expect(migrationSource).toContain('"contextIsValid"');
    expect(migrationSource).toContain("COALESCE((");
    expect(migrationSource).toContain("IS NOT DISTINCT FROM");
    expect(migrationSource).toContain("ELSE NULL");
    expect(migrationSource).not.toContain('"activeVersionId"');
    expect(migrationSource).not.toContain('"ConversationEpisode"');
  });
});
