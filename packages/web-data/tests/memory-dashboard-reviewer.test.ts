import { beforeEach, describe, expect, it, vi } from "vitest";

const governanceMocks = vi.hoisted(() => ({
  approveMemoryCandidate: vi.fn(),
  blockMemoryCandidate: vi.fn(),
  rejectMemoryCandidate: vi.fn(),
}));

vi.mock("../src/memory-governance", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/memory-governance")>(),
  approveMemoryCandidate: governanceMocks.approveMemoryCandidate,
  blockMemoryCandidate: governanceMocks.blockMemoryCandidate,
  rejectMemoryCandidate: governanceMocks.rejectMemoryCandidate,
}));

import {
  executeMemoryDashboardAction,
  getMemoryDashboardSettings,
  listMemoryDashboardEntries,
} from "../src/memory-dashboard";

describe("memory dashboard reviewer boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const operation of [
      governanceMocks.approveMemoryCandidate,
      governanceMocks.rejectMemoryCandidate,
      governanceMocks.blockMemoryCandidate,
    ]) {
      operation.mockResolvedValue({ status: "reviewed" });
    }
  });

  it("allows an APPROVER to list pending candidates only", async () => {
    const candidateFindMany = vi.fn(async () => []);
    const governedFindMany = vi.fn(async () => []);
    const policyFindUnique = vi.fn(async () => null);
    const client = reviewerClient({
      memoryCandidate: { findMany: candidateFindMany },
      governedMemory: { findMany: governedFindMany },
      representativeMemoryPolicy: { findUnique: policyFindUnique },
    });

    await expect(listMemoryDashboardEntries({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
      query: { rep: "delegate" },
    }, { client: client as never })).resolves.toMatchObject({ items: [] });
    expect(candidateFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PENDING_REVIEW" }),
    }));
    expect(governedFindMany).not.toHaveBeenCalled();
    expect(policyFindUnique).not.toHaveBeenCalled();

    await expect(listMemoryDashboardEntries({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
      query: { rep: "delegate", kind: "memory" },
    }, { client: client as never })).rejects.toMatchObject({
      code: "memory_dashboard_forbidden",
      statusCode: 403,
    });
  });

  it.each([
    ["approve_candidate", governanceMocks.approveMemoryCandidate],
    ["reject_candidate", governanceMocks.rejectMemoryCandidate],
    ["block_candidate", governanceMocks.blockMemoryCandidate],
  ] as const)("allows an APPROVER to execute %s", async (action, operation) => {
    await expect(executeMemoryDashboardAction({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
      requestId: `request-${action}`,
      idempotencyKey: `idempotency-${action}`,
      action: {
        action,
        candidateId: "candidate-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "reviewer_decision",
      },
    }, { client: reviewerClient() as never })).resolves.toMatchObject({
      result: { status: "reviewed" },
    });
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
      candidateId: "candidate-1",
    }), expect.any(Object));
  });

  it("denies settings and full-governance actions to an APPROVER", async () => {
    const client = reviewerClient();
    await expect(getMemoryDashboardSettings({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
    }, { client: client as never })).rejects.toMatchObject({
      code: "memory_dashboard_forbidden",
      statusCode: 403,
    });
    await expect(executeMemoryDashboardAction({
      actorOwnerId: "reviewer-1",
      representativeSlug: "delegate",
      requestId: "request-suppress",
      idempotencyKey: "idempotency-suppress",
      action: {
        action: "suppress_memory",
        memoryId: "memory-1",
        expectedUpdatedAt: "2026-08-04T00:00:00.000Z",
        reasonCode: "reviewer_attempt",
      },
    }, { client: client as never })).rejects.toMatchObject({
      code: "memory_dashboard_forbidden",
      statusCode: 403,
    });
  });
});

function reviewerClient(extra: Record<string, unknown> = {}) {
  return {
    representative: {
      findUnique: vi.fn(async () => ({
        id: "rep-1",
        slug: "delegate",
        displayName: "Delegate",
        ownerId: "owner-1",
        activeVersionId: "version-1",
        owner: { organizationId: "org-1", timezone: "UTC" },
      })),
    },
    owner: {
      findUnique: vi.fn(async () => ({
        organizationId: "org-1",
        timezone: "UTC",
        organizationMember: {
          organizationId: "org-1",
          role: "APPROVER",
        },
      })),
    },
    ...extra,
  };
}
