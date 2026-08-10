import { createHash } from "node:crypto";

import {
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedSharedContactMemoryVersionUri,
  OpenVikingRequestError,
} from "@delegate/openviking";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  MemoryProjectionProviderError,
  requeuePolicyEnabledGovernedMemoryProjections,
  runNextMemoryDeletionCleanup,
  runNextMemoryProjectionDeletion,
  runNextMemoryProjectionWrite,
  type MemoryProjectionProvider,
} from "../src/memory-projection-execution";

const safeText = "Prefers concise answers.";
const contentHash = createHash("sha256").update(safeText).digest("hex");

describe("memory projection execution", () => {
  it("recovers only proof-free policy tombstones and never ordinary FAILED work", async () => {
    const query = vi.fn(async (_query: unknown) => [{ id: "projection_1" }]);
    const client = { $queryRaw: query } as unknown as PrismaClient;

    await expect(requeuePolicyEnabledGovernedMemoryProjections(
      client,
      { representativeId: "rep_1" },
      ["openviking"],
    )).resolves.toBe(1);

    const sql = sqlText(query.mock.calls[0]![0]);
    expect(sql).toContain('FROM "MemoryDeletionProof" proof');
    expect(sql).toContain("projection.\"status\" IN");
    expect(sql).toContain("'DELETE_PENDING'::\"MemoryProjectionStatus\"");
    expect(sql).toContain("'DELETE_FAILED'::\"MemoryProjectionStatus\"");
    expect(sql).toContain("'DELETED'::\"MemoryProjectionStatus\"");
    expect(sql).not.toContain("'FAILED'::\"MemoryProjectionStatus\"");
    expect(sql).toContain('memory_record."status" = \'ACTIVE\'');
    expect(sql).toContain('memory_record."currentVersionId" = projection."memoryVersionId"');
    expect(sql).toContain('memory_record."expiresAt" > CURRENT_TIMESTAMP');
    expect(sql).toContain(
      'memory_record."sourceChannel" = \'WEB\'::"RepresentativeChannelKind"',
    );
    expect(sql).toContain('LEFT JOIN "MemoryCandidate" candidate');
    expect(sql).toContain('policy."matrixRecallEnabled"');
    expect(sql).toContain('policy."telegramRecallEnabled"');
    expect(sql).toContain(
      'memory_record."scope" = \'CONTACT_SHARED\'::"MemoryScope"',
    );
    expect(sql).toContain('policy."contactMemoryCrossChannelEnabled"');
    expect(sql).toContain('consent."policyRevision" = policy."revision"');
    expect(sql).toContain('consent."consentVersion" =');
    expect(queryValues(query.mock.calls[0]![0])).toContain(
      "cross-channel-contact-memory-v1",
    );
    expect(sql).toContain('identity_link."revokedAt" IS NULL');
    expect(sql).toContain(
      '"memory_private_channel_disclosure_scope_allows"',
    );
    expect(sql).toContain(
      'candidate."sourceContactId" IS NOT DISTINCT FROM memory_record."contactId"',
    );
    expect(sql).toContain('SET "status" = \'QUEUED\'');
    expect(queryValues(query.mock.calls[0]![0])).toContain("rep_1");
  });

  it("claims with SKIP LOCKED, leaves the transaction, ensures the exact root, and verifies before ACTIVE", async () => {
    const claim = projectionClaim();
    const events: string[] = [];
    const client = projectionClient(claim, [{ status: "ACTIVE" }], events);
    const provider = fakeProvider(events);

    const result = await runNextMemoryProjectionWrite({ client, provider });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "completed",
    });
    expect(events).toEqual([
      "transaction:begin",
      "transaction:end",
      "ensure",
      "write",
      "inspect:present",
      "transaction:begin",
      "completion",
      "transaction:end",
    ]);
    const transactionSql = sqlCalls(client.__txQuery);
    expect(transactionSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(transactionSql).toContain("projection_write_lease_expired");
    expect(transactionSql).toContain('"leaseToken"');
    expect(transactionSql).toContain('FROM "MemoryPolicyDecision" decision');
    expect(transactionSql).toContain("'ACTIVATED'");
    expect(transactionSql).toContain("'UPDATED'");
    expect(transactionSql).not.toContain('FROM "MemoryReviewDecision" decision');
    expect(provider.ensureRoot).toHaveBeenCalledWith({
      namespaceKey: claim.namespaceKey,
      rootUri: claim.remoteUri.replace(/memories\/memory_1\/versions\/version_1\.md$/u, ""),
    });
    expect(sqlValues(client.__txQuery)).toContain("fake");
    expect(sqlValues(client.__txQuery)).not.toContain("openviking");
  });

  it("writes a shared-contact projection only below its canonical identity root", async () => {
    const remoteUri = buildGovernedSharedContactMemoryVersionUri({
      namespaceKey: "namespace_1",
      audienceIdentityId: "identity_1",
      memoryId: "memory_1",
      memoryVersionId: "version_1",
    });
    const claim = projectionClaim({
      remoteUri,
      memoryScope: "CONTACT_SHARED",
      memoryContactId: null,
      memoryAudienceIdentityId: "identity_1",
      memorySourceChannel: null,
    });
    const provider = fakeProvider();
    const client = projectionClient(claim, [{ status: "ACTIVE" }]);

    await expect(runNextMemoryProjectionWrite({ client, provider }))
      .resolves.toMatchObject({ processed: true, status: "completed" });
    expect(provider.ensureRoot).toHaveBeenCalledWith({
      namespaceKey: "namespace_1",
      rootUri: remoteUri.replace(
        /memories\/memory_1\/versions\/version_1\.md$/u,
        "",
      ),
    });
    const completionSql = sqlCalls(client.__txQuery);
    expect(completionSql).toContain('policy."contactMemoryCrossChannelEnabled"');
    expect(completionSql).toContain('shared_decision."policyRevision" = policy."revision"');
    expect(completionSql).toContain('consent."revokedAt" IS NULL');
    expect(completionSql).toContain('MAX(latest_consent."consentVersion")');
    expect(sqlValues(client.__txQuery)).toContain(
      "cross-channel-contact-memory-v1",
    );
  });

  it("rejects a shared projection URI for a different canonical identity", async () => {
    const claim = projectionClaim({
      remoteUri: buildGovernedSharedContactMemoryVersionUri({
        namespaceKey: "namespace_1",
        audienceIdentityId: "identity_other",
        memoryId: "memory_1",
        memoryVersionId: "version_1",
      }),
      memoryScope: "CONTACT_SHARED",
      memoryContactId: null,
      memoryAudienceIdentityId: "identity_1",
      memorySourceChannel: null,
    });
    const provider = fakeProvider();
    const client = projectionClient(claim, [{ status: "FAILED" }]);

    await expect(runNextMemoryProjectionWrite({ client, provider }))
      .resolves.toMatchObject({
        processed: true,
        status: "failed",
        errorCode: "projection_canonical_uri_invalid",
      });
    expect(provider.ensureRoot).not.toHaveBeenCalled();
    expect(provider.writeExact).not.toHaveBeenCalled();
  });

  it("leaves unsupported legacy provider work unclaimed by the production worker", async () => {
    const writeClaim = projectionClaim({ provider: "projection-test" });
    const writeClient = projectionClient(writeClaim, [{ status: "ACTIVE" }]);
    const deleteClaim = projectionClaim({
      provider: "projection-test",
      deleteRequestedAt: new Date(),
    });
    const deleteClient = projectionClient(
      deleteClaim,
      [{ id: deleteClaim.id }],
      [],
      "delete",
    );
    const proof = cleanupClaim();
    const cleanup = cleanupClient(proof, [], false, "projection-test");

    await expect(runNextMemoryProjectionWrite({ client: writeClient }))
      .resolves.toEqual({ processed: false });
    await expect(runNextMemoryProjectionDeletion({ client: deleteClient }))
      .resolves.toEqual({ processed: false });
    await expect(runNextMemoryDeletionCleanup({ client: cleanup }))
      .resolves.toEqual({ processed: false });

    expect(sqlValues(writeClient.__txQuery)).toContain("openviking");
    expect(sqlCalls(writeClient.__txQuery).match(
      /projection\."provider" IN/g,
    )).toHaveLength(3);
    expect(sqlValues(deleteClient.__txQuery)).toContain("openviking");
    expect(sqlCalls(deleteClient.__txQuery).match(
      /projection\."provider" IN/g,
    )).toHaveLength(2);
    expect(sqlCalls(cleanup.__txQuery).match(
      /unsupported_projection\."provider" NOT IN/g,
    )).toHaveLength(3);
    expect(cleanup.memoryCandidate.updateMany).not.toHaveBeenCalled();
  });

  it("claims an explicitly declared resolver capability", async () => {
    const claim = projectionClaim({
      provider: "resolver-test",
      policyProvider: "resolver-test",
    });
    const client = projectionClient(claim, [{ status: "ACTIVE" }]);
    const provider = {
      ...fakeProvider(),
      name: "resolver-test",
    };
    const resolveProvider = vi.fn((providerName: string) =>
      providerName === provider.name ? provider : null
    );

    const result = await runNextMemoryProjectionWrite({
      client,
      resolveProvider,
      supportedProviderNames: ["resolver-test"],
    });

    expect(result).toMatchObject({ processed: true, status: "completed" });
    expect(resolveProvider).toHaveBeenCalledWith("resolver-test");
    expect(sqlValues(client.__txQuery)).toContain("resolver-test");
  });

  it("still reports a disabled production OpenViking provider", async () => {
    vi.stubEnv("OPENVIKING_ENABLED", "false");
    const claim = projectionClaim({
      provider: "openviking",
      policyProvider: "openviking",
    });
    const client = projectionClient(claim, [{ status: "FAILED" }]);

    try {
      await expect(runNextMemoryProjectionWrite({ client })).resolves.toEqual({
        processed: true,
        workId: claim.id,
        status: "failed",
        errorCode: "projection_provider_disabled",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never promotes a write when the completion CAS observes a deletion request", async () => {
    const claim = projectionClaim();
    const client = projectionClient(claim, [{ status: "DELETE_PENDING" }]);
    const result = await runNextMemoryProjectionWrite({
      client,
      provider: fakeProvider(),
    });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "completed",
      errorCode: "projection_not_authoritative",
    });
    expect(sqlCalls(client.__txQuery)).toContain(
      'ELSE \'DELETE_PENDING\'::"MemoryProjectionStatus"',
    );
  });

  it("discards a stale completion when its lease token no longer wins CAS", async () => {
    const claim = projectionClaim();
    const client = projectionClient(claim, []);
    const result = await runNextMemoryProjectionWrite({
      client,
      provider: fakeProvider(),
    });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "lease_lost",
      errorCode: "projection_lease_lost",
    });
    expect(sqlCalls(client.__txQuery)).toContain(
      'AND projection."leaseToken" =',
    );
    expect(sqlCalls(client.__txQuery)).toContain(
      'AND projection."leaseExpiresAt" > CURRENT_TIMESTAMP',
    );
  });

  it("repairs a hash mismatch by exact delete and absence proof before recreating the same leaf", async () => {
    const claim = projectionClaim({
      previousErrorCode: "reconciliation_hash_mismatch",
      previousWriteReceiptHash: "a".repeat(64),
    });
    const events: string[] = [];
    const provider = fakeProvider(events);
    vi.mocked(provider.inspectExact)
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: true,
        contentHash: "b".repeat(64),
        receipt: "inspect-wrong",
      })
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: false,
        receipt: "inspect-absent",
      })
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: true,
        contentHash,
        receipt: "inspect-correct",
      });
    const client = projectionClient(claim, [{ status: "ACTIVE" }], events);

    const result = await runNextMemoryProjectionWrite({ client, provider });

    expect(result).toMatchObject({ processed: true, status: "completed" });
    expect(provider.deleteExact).toHaveBeenCalledTimes(1);
    expect(provider.deleteExact).toHaveBeenCalledWith({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    expect(provider.writeExact).toHaveBeenCalledWith(expect.objectContaining({
      uri: claim.remoteUri,
      contentHash,
    }));
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("ensure"));
    expect(sqlCalls(client.__txQuery)).toContain(
      'WHEN ? THEN CURRENT_TIMESTAMP',
    );
  });

  it("keeps a conflicting write recoverable without creating a business deletion request", async () => {
    const claim = projectionClaim();
    const provider = fakeProvider();
    vi.mocked(provider.writeExact).mockRejectedValueOnce(
      new MemoryProjectionProviderError(
        "projection_content_conflict",
        "Different bytes already exist.",
        false,
        true,
      ),
    );
    const client = projectionClient(claim, [{ status: "RETRYING" }]);

    const result = await runNextMemoryProjectionWrite({ client, provider });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "retrying",
      errorCode: "projection_content_conflict",
    });
    const failureSql = sqlCalls(client.__clientQuery);
    expect(failureSql).not.toContain(
      'COALESCE("deleteRequestedAt", CURRENT_TIMESTAMP)',
    );
  });

  it.each([
    [
      "a malformed successful response",
      new Error("OpenViking returned an invalid governed memory write result."),
    ],
    [
      "an invalid 2xx envelope",
      new OpenVikingRequestError("OpenViking returned an invalid envelope.", 200),
    ],
    [
      "a request timeout",
      new OpenVikingRequestError("OpenViking request timed out.", 408),
    ],
  ])("marks %s for exact cleanup before retry", async (_label, error) => {
    const claim = projectionClaim();
    const provider = fakeProvider();
    vi.mocked(provider.writeExact).mockRejectedValueOnce(error);
    const client = projectionClient(claim, [{ status: "RETRYING" }]);

    const result = await runNextMemoryProjectionWrite({ client, provider });

    expect(result).toMatchObject({
      processed: true,
      status: "retrying",
      errorCode: "projection_write_provider_failed",
    });
    expect(sqlValues(client.__clientQuery)).toContain(
      "projection_write_cleanup_required",
    );
  });

  it.each([400, 401, 403, 404, 422, 425, 429])(
    "does not treat an explicit HTTP %s write rejection as an ambiguous commit",
    async (status) => {
      const claim = projectionClaim();
      const provider = fakeProvider();
      vi.mocked(provider.writeExact).mockRejectedValueOnce(
        new OpenVikingRequestError("Write rejected before commit.", status),
      );
      const client = projectionClient(claim, [{
        status: status === 425 || status === 429 ? "RETRYING" : "FAILED",
      }]);

      const result = await runNextMemoryProjectionWrite({ client, provider });

      expect(result).toMatchObject({
        processed: true,
        status: status === 425 || status === 429 ? "retrying" : "failed",
      });
      expect(sqlValues(client.__clientQuery)).not.toContain(
        "projection_write_cleanup_required",
      );
    },
  );

  it("cleans an ambiguous prior write and recreates the same immutable URI", async () => {
    const claim = projectionClaim({
      previousErrorCode: "projection_write_cleanup_required",
    });
    const events: string[] = [];
    const provider = fakeProvider(events);
    vi.mocked(provider.inspectExact)
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: true,
        contentHash,
        receipt: "inspect-existing",
      })
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: false,
        receipt: "inspect-absent",
      })
      .mockResolvedValueOnce({
        uri: claim.remoteUri,
        exists: true,
        contentHash,
        receipt: "inspect-correct",
      });
    const client = projectionClient(claim, [{ status: "ACTIVE" }], events);

    const result = await runNextMemoryProjectionWrite({ client, provider });

    expect(result).toMatchObject({ processed: true, status: "completed" });
    expect(provider.deleteExact).toHaveBeenCalledWith({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    expect(provider.writeExact).toHaveBeenCalledWith(expect.objectContaining({
      uri: claim.remoteUri,
      contentHash,
    }));
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("write"));
  });

  it("keeps an exhausted ambiguous write fenced, then cleans and restores the same URI on the next tick", async () => {
    const ambiguousClaim = projectionClaim({ attemptCount: 1 });
    const ambiguousProvider = fakeProvider();
    vi.mocked(ambiguousProvider.writeExact).mockRejectedValueOnce(
      new Error("The write response was lost."),
    );
    const ambiguousClient = projectionClient(
      ambiguousClaim,
      [{ status: "RETRYING" }],
    );

    const ambiguousResult = await runNextMemoryProjectionWrite({
      client: ambiguousClient,
      provider: ambiguousProvider,
      maximumWriteAttempts: 1,
    });

    expect(ambiguousResult).toMatchObject({
      processed: true,
      status: "retrying",
      errorCode: "projection_write_provider_failed",
    });
    expect(sqlValues(ambiguousClient.__clientQuery)).toContain(
      "projection_write_cleanup_required",
    );
    const claimSql = sqlCalls(ambiguousClient.__txQuery);
    expect(claimSql).toContain(
      'projection."lastErrorCode" IS DISTINCT FROM \'projection_write_cleanup_required\'',
    );
    expect(claimSql).toContain(
      'OR projection."lastErrorCode" = \'projection_write_cleanup_required\'',
    );

    const repairClaim = projectionClaim({
      attemptCount: 2,
      previousErrorCode: "projection_write_cleanup_required",
    });
    const events: string[] = [];
    const repairProvider = fakeProvider(events);
    vi.mocked(repairProvider.inspectExact)
      .mockResolvedValueOnce({
        uri: repairClaim.remoteUri,
        exists: true,
        contentHash,
        receipt: "inspect-existing",
      })
      .mockResolvedValueOnce({
        uri: repairClaim.remoteUri,
        exists: false,
        receipt: "inspect-absent",
      })
      .mockResolvedValueOnce({
        uri: repairClaim.remoteUri,
        exists: true,
        contentHash,
        receipt: "inspect-restored",
      });
    const repairClient = projectionClient(
      repairClaim,
      [{ status: "ACTIVE" }],
      events,
    );

    const repairResult = await runNextMemoryProjectionWrite({
      client: repairClient,
      provider: repairProvider,
      maximumWriteAttempts: 1,
    });

    expect(repairResult).toMatchObject({ processed: true, status: "completed" });
    expect(repairProvider.deleteExact).toHaveBeenCalledWith({
      namespaceKey: repairClaim.namespaceKey,
      uri: ambiguousClaim.remoteUri,
    });
    expect(repairProvider.writeExact).toHaveBeenCalledWith(
      expect.objectContaining({ uri: ambiguousClaim.remoteUri }),
    );
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("write"));
  });

  it("never terminates an exhausted cleanup fence when its exact probe fails", async () => {
    const claim = projectionClaim({
      attemptCount: 9,
      previousErrorCode: "projection_write_cleanup_required",
    });
    const provider = fakeProvider();
    vi.mocked(provider.inspectExact).mockRejectedValueOnce(
      new OpenVikingRequestError("Probe rejected.", 403),
    );
    const client = projectionClient(claim, [{ status: "RETRYING" }]);

    const result = await runNextMemoryProjectionWrite({
      client,
      provider,
      maximumWriteAttempts: 1,
    });

    expect(result).toMatchObject({ processed: true, status: "retrying" });
    expect(provider.deleteExact).not.toHaveBeenCalled();
    expect(provider.writeExact).not.toHaveBeenCalled();
    expect(sqlValues(client.__clientQuery)).toContain(
      "projection_write_cleanup_required",
    );
  });

  it("may terminate an exhausted repair after absence is proven and the rewrite is explicitly rejected", async () => {
    const claim = projectionClaim({
      attemptCount: 2,
      previousErrorCode: "projection_write_cleanup_required",
    });
    const provider = fakeProvider();
    vi.mocked(provider.inspectExact).mockResolvedValueOnce({
      uri: claim.remoteUri,
      exists: false,
      receipt: "inspect-absent",
    });
    vi.mocked(provider.writeExact).mockRejectedValueOnce(
      new OpenVikingRequestError("Rewrite rejected before commit.", 422),
    );
    const client = projectionClient(claim, [{ status: "FAILED" }]);

    const result = await runNextMemoryProjectionWrite({
      client,
      provider,
      maximumWriteAttempts: 1,
    });

    expect(result).toMatchObject({ processed: true, status: "failed" });
    expect(provider.deleteExact).not.toHaveBeenCalled();
    expect(sqlValues(client.__clientQuery)).not.toContain(
      "projection_write_cleanup_required",
    );
  });

  it("deletes only the exact leaf and requires a post-delete absence observation", async () => {
    const claim = projectionClaim({ deleteRequestedAt: new Date() });
    const events: string[] = [];
    const client = projectionClient(claim, [{ id: claim.id }], events, "delete");
    const provider = fakeProvider(events, false);

    const result = await runNextMemoryProjectionDeletion({ client, provider });

    expect(result).toMatchObject({ processed: true, status: "completed" });
    expect(provider.deleteExact).toHaveBeenCalledWith({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    expect(provider.inspectExact).toHaveBeenCalledWith({
      namespaceKey: claim.namespaceKey,
      uri: claim.remoteUri,
    });
    const completionSql = sqlCalls(client.__txQuery);
    expect(completionSql).toContain("'DELETED'::\"MemoryProjectionStatus\"");
    expect(completionSql).toContain('"deleteReceiptHash"');
    expect(completionSql).toContain('"remoteAbsentAt"');
  });

  it("keeps a deletion proof retrying until every projection has drained", async () => {
    const claim = cleanupClaim();
    const client = cleanupClient(claim, [
      {
        id: "projection_1",
        status: "DELETING",
        leaseToken: "delete-lease",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        deleteReceiptHash: null,
        remoteAbsentAt: null,
      },
    ]);

    const result = await runNextMemoryDeletionCleanup({ client });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "retrying",
      errorCode: "projection_drain_pending",
    });
    expect(sqlCalls(client.__txQuery)).toContain("projection_drain_pending");
    expect(client.memoryCandidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ safeText: null, summary: null }),
      }),
    );
    expect(client.governedMemory.updateMany).not.toHaveBeenCalled();
  });

  it("automatically requeues due failed deletion proofs behind the recall fence", async () => {
    const claim = cleanupClaim();
    const client = cleanupClient(claim, []);

    await runNextMemoryDeletionCleanup({ client });

    const sql = sqlCalls(client.__txQuery);
    expect(sql).toContain("WITH retryable_failed AS MATERIALIZED");
    expect(sql).toContain("proof.\"cleanupStatus\" = 'FAILED'::\"MemoryCleanupStatus\"");
    expect(sql).toContain("memory_record.\"status\" = 'DELETE_PENDING'::\"GovernedMemoryStatus\"");
    expect(sql).toContain("SET \"cleanupStatus\" = 'QUEUED'::\"MemoryCleanupStatus\"");
    expect(sql).toContain("FOR UPDATE OF proof SKIP LOCKED");
  });

  it("completes a body-free proof only after every exact absence receipt is present", async () => {
    const claim = cleanupClaim();
    const client = cleanupClient(claim, [
      {
        id: "projection_1",
        status: "DELETED",
        leaseToken: null,
        leaseExpiresAt: null,
        deleteReceiptHash: "d".repeat(64),
        remoteAbsentAt: new Date(),
      },
    ], true);

    const result = await runNextMemoryDeletionCleanup({ client });

    expect(result).toEqual({
      processed: true,
      workId: claim.id,
      status: "completed",
    });
    expect(sqlCalls(client.__txQuery)).toContain(
      "'SUCCEEDED'::\"MemoryCleanupStatus\"",
    );
    expect(sqlCalls(client.__txQuery)).toContain('"providerReceiptHash"');
    expect(client.governedMemory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DELETED" }) }),
    );
  });
});

function projectionClaim(overrides: Record<string, unknown> = {}) {
  const namespaceKey = "namespace_1";
  const remoteUri = buildGovernedContactChannelMemoryVersionUri({
    namespaceKey,
    contactId: "contact_1",
    channel: "web",
    memoryId: "memory_1",
    memoryVersionId: "version_1",
  });
  return {
    id: "projection_1",
    representativeId: "representative_1",
    memoryId: "memory_1",
    memoryVersionId: "version_1",
    provider: "fake",
    lane: "RECALL",
    remoteUri,
    contentHash,
    attemptCount: 1,
    leaseToken: "lease_1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    deleteRequestedAt: null,
    safeText,
    versionContentHash: contentHash,
    versionPurgedAt: null,
    memoryStatus: "ACTIVE",
    currentVersionId: "version_1",
    recallDisabledAt: null,
    memoryScope: "CONTACT_CHANNEL",
    memoryContactId: "contact_1",
    memoryAudienceIdentityId: null,
    memorySourceChannel: "WEB",
    namespaceKey,
    policyProvider: "fake",
    longTermMemoryEnabled: true,
    previousErrorCode: null,
    previousWriteReceiptHash: null,
    ...overrides,
  };
}

function cleanupClaim() {
  return {
    id: "proof_1",
    representativeId: "representative_1",
    memoryId: "memory_1",
    requestId: "request_1",
    reasonCode: "owner_request",
    contentHash,
    recallBlockedAt: new Date("2026-08-04T00:00:00.000Z"),
    attemptCount: 1,
    leaseToken: "cleanup_lease_1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function fakeProvider(
  events: string[] = [],
  presentAfterDelete = true,
): MemoryProjectionProvider {
  const claim = projectionClaim();
  return {
    name: "fake",
    ensureRoot: vi.fn(async (input) => {
      events.push("ensure");
      return { rootUri: input.rootUri, receipt: "ensure" };
    }),
    writeExact: vi.fn(async (input) => {
      events.push("write");
      return {
        uri: input.uri,
        contentHash: input.contentHash,
        receipt: "write",
      };
    }),
    inspectExact: vi.fn(async (input) => {
      events.push(presentAfterDelete ? "inspect:present" : "inspect:absent");
      return presentAfterDelete
        ? {
            uri: input.uri,
            exists: true,
            contentHash: claim.contentHash,
            receipt: "inspect-present",
          }
        : {
            uri: input.uri,
            exists: false,
            receipt: "inspect-absent",
          };
    }),
    deleteExact: vi.fn(async (input) => {
      events.push("delete");
      return {
        uri: input.uri,
        outcome: "deleted" as const,
        receipt: "delete",
      };
    }),
  };
}

function projectionClient(
  claim: ReturnType<typeof projectionClaim>,
  completionRows: unknown[],
  events: string[] = [],
  lane: "write" | "delete" = "write",
) {
  const txQuery = vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("claimed_projection")) {
      return queryValues(query).includes(claim.provider) ? [claim] : [];
    }
    if (
      text.includes("WITH completion_candidate AS MATERIALIZED")
      || text.includes('SET "status" = \'DELETED\'::"MemoryProjectionStatus"')
    ) {
      events.push("completion");
      return completionRows;
    }
    return [];
  });
  const clientQuery = vi.fn(async () => completionRows);
  const client = {
    __txQuery: txQuery,
    __clientQuery: clientQuery,
    $queryRaw: clientQuery,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      events.push("transaction:begin");
      const result = await callback({ $queryRaw: txQuery });
      events.push("transaction:end");
      return result;
    }),
    __lane: lane,
  };
  return client as unknown as PrismaClient & typeof client;
}

function cleanupClient(
  claim: ReturnType<typeof cleanupClaim>,
  projections: Array<Record<string, unknown>>,
  completes = false,
  projectionProvider = "openviking",
) {
  let transactionNumber = 0;
  const txQuery = vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("claimed_proof")) {
      return queryValues(query).includes(projectionProvider) ? [claim] : [];
    }
    if (text.includes("FOR UPDATE OF proof, memory_record")) return [{ id: claim.id }];
    if (text.includes('SELECT "id", "status", "leaseToken"')) return projections;
    if (text.includes("projection_drain_pending")) return [{ id: claim.id }];
    if (text.includes('AS "completionAt"')) {
      return [{
        ...claim,
        localPurgeCompletedAt: new Date("2026-08-04T00:00:01.000Z"),
        completionAt: new Date("2026-08-04T00:00:02.000Z"),
      }];
    }
    if (text.includes("'SUCCEEDED'::\"MemoryCleanupStatus\"")) {
      return completes
        ? [{
            localPurgeCompletedAt: new Date(),
            remotePurgeCompletedAt: new Date(),
          }]
        : [];
    }
    return [];
  });
  const memoryCandidate = { updateMany: vi.fn(async () => ({ count: 1 })) };
  const governedMemoryVersion = { updateMany: vi.fn(async () => ({ count: 1 })) };
  const governedMemory = {
    updateMany: vi.fn(async () => ({ count: completes ? 1 : 0 })),
  };
  const client = {
    __txQuery: txQuery,
    memoryCandidate,
    governedMemoryVersion,
    governedMemory,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      transactionNumber += 1;
      return callback({
        $queryRaw: txQuery,
        memoryCandidate,
        governedMemoryVersion,
        governedMemory,
      });
    }),
    __transactionNumber: () => transactionNumber,
  };
  return client as unknown as PrismaClient & typeof client;
}

function sqlCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([query]) => sqlText(query)).join("\n");
}

function sqlValues(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.flatMap(([query]) => queryValues(query));
}

function queryValues(query: unknown) {
  return typeof query === "object"
    && query !== null
    && "values" in query
    && Array.isArray(query.values)
    ? query.values
    : [];
}

function sqlText(query: unknown) {
  if (
    typeof query === "object"
    && query !== null
    && "strings" in query
    && Array.isArray(query.strings)
  ) {
    return query.strings.join("?");
  }
  return String(query);
}
