import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  buildGovernedRepresentativeExperienceVersionUri,
  OpenVikingClient,
} from "@delegate/openviking";
import { describe, expect, it, vi } from "vitest";

import {
  classifyMemoryReconciliationExactProbe,
  OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
  OpenVikingMemoryReconciliationProvider,
  runNextMemoryReconciliation,
  type MemoryReconciliationClaim,
  type MemoryReconciliationCoverage,
  type MemoryReconciliationPageCommit,
  type MemoryReconciliationProvider,
  type MemoryReconciliationRepository,
  type MemoryReconciliationTargetClaim,
  type MemoryReconciliationTargetObservation,
} from "../src/memory-reconciliation-execution";

const source = readFileSync(
  new URL("../src/memory-reconciliation-execution.ts", import.meta.url),
  "utf8",
);

describe("memory reconciliation exact-probe execution", () => {
  it("claims only one worker while a concurrent exact probe is in flight", async () => {
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const repository = new RecordingRepository(baseClaim("EXPECTED_ACTIVE"));
    const inspectExact = vi.fn(async (input: { uri: string }) => {
      await probeGate;
      return {
        uri: input.uri,
        exists: true,
        contentHash: expectedHash,
      };
    });
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact,
    };

    const first = runNextMemoryReconciliation({ repository, provider });
    const second = runNextMemoryReconciliation({ repository, provider });
    await vi.waitFor(() => expect(repository.claimCalls).toBe(2));
    releaseProbe();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect([firstResult.processed, secondResult.processed].sort()).toEqual([
      false,
      true,
    ]);
    expect(inspectExact).toHaveBeenCalledOnce();
    expect(repository.completeCalls).toBe(1);
  });

  it("allows an injected lease repository to reclaim an expired run", async () => {
    const expiredLease = {
      token: "expired-token",
      expiresAt: new Date(Date.now() - 10_000),
    };
    const repository = new ExpiredLeaseRepository(
      baseClaim("EXPECTED_ACTIVE"),
      expiredLease,
    );
    const provider = matchingProvider();

    const result = await runNextMemoryReconciliation({ repository, provider });

    expect(result).toMatchObject({ processed: true, status: "partial" });
    expect(repository.recoveredExpiredLease).toBe(true);
    expect(repository.claimedLeaseToken).not.toBe(expiredLease.token);
  });

  it("idempotently ensures a periodic run before claiming work", async () => {
    const now = new Date("2026-08-04T01:02:03.000Z");
    const repository = new PeriodicDueRepository(baseClaim("EXPECTED_ACTIVE"));

    const first = await runNextMemoryReconciliation({
      repository,
      provider: matchingProvider(),
      now: () => now,
      reconciliationIntervalMilliseconds: 300_000,
    });
    const second = await runNextMemoryReconciliation({
      repository,
      provider: matchingProvider(),
      now: () => now,
      reconciliationIntervalMilliseconds: 300_000,
    });

    expect(first).toMatchObject({ processed: true, status: "partial" });
    expect(second).toMatchObject({ processed: false });
    expect(repository.createdRunCount).toBe(1);
    expect(repository.ensureCalls).toBe(2);
  });

  it("leaves unsupported legacy provider work unclaimed by the production worker", async () => {
    const repository = new RecordingRepository(
      claimForProvider("reconciliation-test"),
    );

    const result = await runNextMemoryReconciliation({ repository });

    expect(result).toMatchObject({ processed: false });
    expect(repository.ensureInput?.supportedProviderNames).toEqual([
      "openviking",
    ]);
    expect(repository.claimInput?.supportedProviderNames).toEqual([
      "openviking",
    ]);
    expect(repository.completeCalls).toBe(0);
  });

  it("uses an injected custom provider as an explicit scheduler capability", async () => {
    const repository = new RecordingRepository(
      claimForProvider("reconciliation-test"),
    );
    const inspectExact = vi.fn(async (input: { uri: string }) => ({
      uri: input.uri,
      exists: true,
      contentHash: expectedHash,
    }));
    const provider: MemoryReconciliationProvider = {
      name: "reconciliation-test",
      inspectExact,
    };

    const result = await runNextMemoryReconciliation({ repository, provider });

    expect(result).toMatchObject({ processed: true, operationalStatus: "ok" });
    expect(repository.ensureInput?.supportedProviderNames).toEqual([
      "reconciliation-test",
    ]);
    expect(repository.claimInput?.supportedProviderNames).toEqual([
      "reconciliation-test",
    ]);
    expect(inspectExact).toHaveBeenCalledOnce();
  });

  it("claims provider capabilities declared for a custom resolver", async () => {
    const repository = new RecordingRepository(
      claimForProvider("resolver-test"),
    );
    const provider: MemoryReconciliationProvider = {
      name: "resolver-test",
      inspectExact: vi.fn(async (input) => ({
        uri: input.uri,
        exists: true,
        contentHash: expectedHash,
      })),
    };
    const resolveProvider = vi.fn((providerName: string) =>
      providerName === provider.name ? provider : null
    );

    const result = await runNextMemoryReconciliation({
      repository,
      resolveProvider,
      supportedProviderNames: ["resolver-test"],
    });

    expect(result).toMatchObject({ processed: true, operationalStatus: "ok" });
    expect(repository.claimInput?.supportedProviderNames).toEqual([
      "resolver-test",
    ]);
    expect(resolveProvider).toHaveBeenCalledWith("resolver-test");
  });

  it("isolates due-run blocking and fairness history by provider", () => {
    expect(source).toMatch(
      /WHERE active_run\."representativeId" = policy\."representativeId"\s+AND active_run\."provider" = policy\."provider"/u,
    );
    expect(source).toMatch(
      /WHERE previous_run\."representativeId" = policy\."representativeId"\s+AND previous_run\."provider" = policy\."provider"/u,
    );
  });

  it("maps an exact OpenViking 404 to MISSING without enumerating remote state", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-OpenViking-User")).toBe(
        "delegate-memory-namespace_1",
      );
      return new Response(JSON.stringify({
        status: "error",
        error: { code: "NOT_FOUND", message: "not found" },
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider = new OpenVikingMemoryReconciliationProvider(
      new OpenVikingClient({
        baseUrl: "http://openviking.test",
        apiKey: "root-key",
        accountId: "delegate",
        userId: "bootstrap",
        fetchImpl,
      }),
    );
    const repository = new RecordingRepository(baseClaim("EXPECTED_ACTIVE"));

    await runNextMemoryReconciliation({ repository, provider });

    expect(repository.observations).toEqual([
      expect.objectContaining({ kind: "missing" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("records a local hash mismatch but does not expose a repair or delete call", async () => {
    const observedContentHash = hashText("remote drift");
    const repository = new RecordingRepository(baseClaim("EXPECTED_ACTIVE"));
    const inspectExact = vi.fn(async (input: { uri: string }) => ({
      uri: input.uri,
      exists: true,
      contentHash: observedContentHash,
    }));
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact,
    };

    await runNextMemoryReconciliation({ repository, provider });

    expect(repository.observations).toEqual([
      expect.objectContaining({
        kind: "hash_mismatch",
        observedContentHash,
      }),
    ]);
    expect(Object.keys(provider)).toEqual(["name", "inspectExact"]);
  });

  it("lets the persistence CAS discard a moving target without creating an issue", async () => {
    const repository = new RecordingRepository(
      baseClaim("EXPECTED_ACTIVE"),
      () => ({
        state: "partial",
        coverage: coverage({ skipped: 1 }),
      }),
    );
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact: vi.fn(async (input) => ({
        uri: input.uri,
        exists: false,
      })),
    };

    const result = await runNextMemoryReconciliation({ repository, provider });

    expect(repository.observations[0]).toMatchObject({ kind: "missing" });
    expect(result).toMatchObject({
      processed: true,
      status: "partial",
      known: { issues: 0, skipped: 1 },
    });
  });

  it("does not probe or misreport a projection with a live writer lease", async () => {
    const repository = new RecordingRepository(baseClaim("LIVE_IN_FLIGHT"));
    const inspectExact = vi.fn();
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact,
    };

    await runNextMemoryReconciliation({ repository, provider });

    expect(inspectExact).not.toHaveBeenCalled();
    expect(repository.observations).toEqual([
      expect.objectContaining({ kind: "live_in_flight" }),
    ]);
  });

  it("retains reversible inactive projections without probing or deleting them", async () => {
    const repository = new RecordingRepository(baseClaim("RETAINED_INACTIVE"));
    const inspectExact = vi.fn();
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact,
    };

    await runNextMemoryReconciliation({ repository, provider });

    expect(inspectExact).not.toHaveBeenCalled();
    expect(repository.observations).toEqual([
      expect.objectContaining({ kind: "retained_inactive" }),
    ]);
  });

  it("fails closed without constructing a default client when OpenViking is disabled", async () => {
    vi.stubEnv("OPENVIKING_ENABLED", "false");
    const repository = new RecordingRepository(baseClaim("EXPECTED_ACTIVE"));
    let result: Awaited<ReturnType<typeof runNextMemoryReconciliation>>;

    try {
      result = await runNextMemoryReconciliation({ repository });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(repository.observations).toEqual([
      expect.objectContaining({
        kind: "permanent_error",
        errorCode: "reconciliation_provider_disabled",
      }),
    ]);
    expect(repository.ensureInput?.supportedProviderNames).toEqual([
      "openviking",
    ]);
    expect(repository.claimInput?.supportedProviderNames).toEqual([
      "openviking",
    ]);
    expect(result).toMatchObject({
      processed: true,
      operationalStatus: "failed",
      operationalErrorCode: "reconciliation_provider_disabled",
    });
  });

  it("always reports partial truth even when every known exact leaf matches", async () => {
    const repository = new RecordingRepository(
      baseClaim("EXPECTED_ACTIVE"),
      () => ({
        state: "partial",
        coverage: coverage({ checked: 1, matched: 1 }),
      }),
    );

    const result = await runNextMemoryReconciliation({
      repository,
      provider: matchingProvider(),
    });

    expect(result).toEqual({
      processed: true,
      runId: "run_1",
      status: "partial",
      inventoryStatus: "partial",
      exactProbe: "supported",
      remoteEnumeration: "unsupported",
      errorCode: OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
      operationalStatus: "ok",
      known: coverage({ checked: 1, matched: 1 }),
    });
  });

  it("requeues retryable provider failures with stable bounded work", async () => {
    const availableAt = new Date(Date.now() + 1_000);
    const repository = new RecordingRepository(
      baseClaim("EXPECTED_ACTIVE"),
      () => ({
        state: "requeued",
        coverage: coverage(),
        availableAt,
      }),
    );
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact: vi.fn(async () => {
        throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      }),
    };

    const result = await runNextMemoryReconciliation({
      repository,
      provider,
      pageSize: 1_000,
    });

    expect(repository.claimInput?.pageSize).toBe(64);
    expect(repository.observations).toEqual([
      expect.objectContaining({
        kind: "retryable_error",
        errorCode: "reconciliation_provider_retryable",
      }),
    ]);
    expect(result).toMatchObject({
      processed: true,
      status: "requeued",
      operationalStatus: "retrying",
      operationalErrorCode: "reconciliation_provider_retryable",
      availableAt,
      remoteEnumeration: "unsupported",
    });
  });

  it("reports failed known targets separately from capability-only partial coverage", async () => {
    const repository = new RecordingRepository(
      baseClaim("EXPECTED_ACTIVE"),
      () => ({
        state: "partial",
        coverage: coverage({ failed: 1 }),
      }),
    );
    const provider: MemoryReconciliationProvider = {
      name: "openviking",
      inspectExact: vi.fn(async () => {
        throw Object.assign(new Error("authorization rejected"), { status: 403 });
      }),
    };

    const result = await runNextMemoryReconciliation({ repository, provider });

    expect(repository.observations).toEqual([
      expect.objectContaining({
        kind: "permanent_error",
        errorCode: "reconciliation_provider_failed",
      }),
    ]);
    expect(result).toMatchObject({
      processed: true,
      status: "partial",
      errorCode: OPENVIKING_INVENTORY_NO_SNAPSHOT_CURSOR,
      operationalStatus: "failed",
      operationalErrorCode: "reconciliation_provider_failed",
      known: { failed: 1 },
    });
  });

  it("keeps ordinary page requeue operationally healthy", async () => {
    const availableAt = new Date(Date.now() + 1_000);
    const claim = baseClaim("EXPECTED_ACTIVE");
    claim.targets = [];
    const repository = new RecordingRepository(
      claim,
      () => ({
        state: "requeued",
        coverage: coverage(),
        availableAt,
      }),
    );

    const result = await runNextMemoryReconciliation({
      repository,
      provider: matchingProvider(),
    });

    expect(result).toMatchObject({
      processed: true,
      status: "requeued",
      operationalStatus: "ok",
      availableAt,
    });
    expect(result).not.toHaveProperty("operationalErrorCode");
  });

  it("keeps a prior-page retry visible while a later page succeeds", async () => {
    const repository = new RecordingRepository(
      baseClaim("EXPECTED_ACTIVE"),
      () => ({
        state: "requeued",
        coverage: coverage({ checked: 1, matched: 1, retrying: 1 }),
        availableAt: new Date(Date.now() + 1_000),
      }),
    );

    const result = await runNextMemoryReconciliation({
      repository,
      provider: matchingProvider(),
    });

    expect(repository.observations).toEqual([
      expect.objectContaining({ kind: "matched" }),
    ]);
    expect(result).toMatchObject({
      processed: true,
      status: "requeued",
      operationalStatus: "retrying",
      operationalErrorCode: "reconciliation_target_retrying",
      known: { matched: 1, retrying: 1, failed: 0 },
    });
  });

  it("classifies only exact match, missing, and content drift", () => {
    expect(classifyMemoryReconciliationExactProbe(expectedHash, {
      uri: canonicalUri,
      exists: true,
      contentHash: expectedHash,
    })).toEqual({ kind: "matched", observedContentHash: expectedHash });
    expect(classifyMemoryReconciliationExactProbe(expectedHash, {
      uri: canonicalUri,
      exists: false,
    })).toEqual({ kind: "missing" });
    const otherHash = hashText("other");
    expect(classifyMemoryReconciliationExactProbe(expectedHash, {
      uri: canonicalUri,
      exists: true,
      contentHash: otherHash,
    })).toEqual({ kind: "hash_mismatch", observedContentHash: otherHash });
  });

  it("keeps SKIP LOCKED, worklist, lease/CAS, and no-delete boundaries explicit", () => {
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain(
      'policy."provider" IN (${supportedProviderSql})',
    );
    expect(source).toContain('run."provider" IN (${supportedProviderSql})');
    expect(source).toContain('"MemoryReconciliationTarget"');
    expect(source).toContain('projection."lane" = \'RECALL\'');
    expect(source).toContain('run."leaseToken" = ${claim.leaseToken}');
    expect(source).toContain('projection."updatedAt" = target."snapshotProjectionUpdatedAt"');
    expect(source).toContain("reconciliation_target_lease_expired");
    expect(source).toContain("ON CONFLICT DO NOTHING");
    expect(source.indexOf("createReconciliationIssue")).toBeLessThan(
      source.indexOf("fenceExpectedProjectionForRetry"),
    );
    expect(source).not.toMatch(/ORPHAN_REMOTE|FOREIGN_REMOTE|DUPLICATE_REMOTE|HEALTHY/u);
    expect(source).not.toMatch(/deleteGovernedMemoryVersion|deleteExact|\/api\/v1\/search\/glob/u);
  });
});

const expectedHash = hashText("safe memory");
const canonicalUri = buildGovernedRepresentativeExperienceVersionUri({
  namespaceKey: "namespace_1",
  memoryId: "memory_1",
  memoryVersionId: "version_1",
});

function baseTarget(
  kind: MemoryReconciliationTargetClaim["kind"],
): MemoryReconciliationTargetClaim {
  return {
    projectionItemId: "projection_1",
    representativeId: "representative_1",
    memoryId: "memory_1",
    memoryVersionId: "version_1",
    provider: "openviking",
    namespaceKey: "namespace_1",
    kind,
    remoteUri: canonicalUri,
    expectedContentHash: expectedHash,
    snapshotProjectionStatus: kind === "LIVE_IN_FLIGHT" ? "PROJECTING" : "ACTIVE",
    snapshotProjectionUpdatedAt: new Date("2026-08-04T00:00:00.000Z"),
    snapshotAttemptCount: 1,
    targetAttemptCount: 1,
  };
}

function baseClaim(
  kind: MemoryReconciliationTargetClaim["kind"],
): MemoryReconciliationClaim {
  return {
    runId: "run_1",
    representativeId: "representative_1",
    provider: "openviking",
    runAttemptCount: 1,
    leaseToken: "lease_1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    targets: [baseTarget(kind)],
  };
}

function claimForProvider(provider: string): MemoryReconciliationClaim {
  const claim = baseClaim("EXPECTED_ACTIVE");
  return {
    ...claim,
    provider,
    targets: claim.targets.map((target) => ({ ...target, provider })),
  };
}

function matchingProvider(): MemoryReconciliationProvider {
  return {
    name: "openviking",
    inspectExact: vi.fn(async (input) => ({
      uri: input.uri,
      exists: true,
      contentHash: expectedHash,
    })),
  };
}

class RecordingRepository implements MemoryReconciliationRepository {
  ensureCalls = 0;
  claimCalls = 0;
  completeCalls = 0;
  ensureInput:
    | Parameters<MemoryReconciliationRepository["ensureDueRun"]>[0]
    | null = null;
  claimInput:
    | Parameters<MemoryReconciliationRepository["claimNext"]>[0]
    | null = null;
  observations: readonly MemoryReconciliationTargetObservation[] = [];
  private claimed = false;

  constructor(
    private readonly claim: MemoryReconciliationClaim,
    private readonly commit: (
      observations: readonly MemoryReconciliationTargetObservation[],
    ) => MemoryReconciliationPageCommit = defaultCommit,
  ) {}

  async ensureDueRun(
    input: Parameters<MemoryReconciliationRepository["ensureDueRun"]>[0],
  ) {
    this.ensureCalls += 1;
    this.ensureInput = input;
    return false;
  }

  async claimNext(
    input: Parameters<MemoryReconciliationRepository["claimNext"]>[0],
  ) {
    this.claimCalls += 1;
    this.claimInput = input;
    if (!input.supportedProviderNames.includes(this.claim.provider)) return null;
    if (this.claimed) return null;
    this.claimed = true;
    return {
      ...this.claim,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(Date.now() + input.leaseMilliseconds),
      targets: this.claim.targets.map((target) => ({ ...target })),
    };
  }

  async completePage(
    input: Parameters<MemoryReconciliationRepository["completePage"]>[0],
  ) {
    this.completeCalls += 1;
    this.observations = input.observations;
    return this.commit(input.observations);
  }
}

class ExpiredLeaseRepository implements MemoryReconciliationRepository {
  recoveredExpiredLease = false;
  claimedLeaseToken: string | null = null;
  private claimed = false;

  constructor(
    private readonly claim: MemoryReconciliationClaim,
    private readonly expiredLease: { token: string; expiresAt: Date },
  ) {}

  async ensureDueRun() {
    return false;
  }

  async claimNext(
    input: Parameters<MemoryReconciliationRepository["claimNext"]>[0],
  ) {
    if (!input.supportedProviderNames.includes(this.claim.provider)) return null;
    if (this.claimed) return null;
    this.claimed = true;
    this.recoveredExpiredLease = this.expiredLease.expiresAt.getTime() <= Date.now();
    this.claimedLeaseToken = input.leaseToken;
    return {
      ...this.claim,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(Date.now() + input.leaseMilliseconds),
    };
  }

  async completePage() {
    return {
      state: "partial" as const,
      coverage: coverage({ checked: 1, matched: 1 }),
    };
  }
}

class PeriodicDueRepository implements MemoryReconciliationRepository {
  ensureCalls = 0;
  createdRunCount = 0;
  private bucket: number | null = null;
  private pending = false;

  constructor(private readonly claim: MemoryReconciliationClaim) {}

  async ensureDueRun(
    input: Parameters<MemoryReconciliationRepository["ensureDueRun"]>[0],
  ) {
    this.ensureCalls += 1;
    if (!input.supportedProviderNames.includes(this.claim.provider)) return false;
    const bucket = Math.floor(
      input.now.getTime() / input.intervalMilliseconds,
    );
    if (this.bucket === bucket) return false;
    this.bucket = bucket;
    this.pending = true;
    this.createdRunCount += 1;
    return true;
  }

  async claimNext(
    input: Parameters<MemoryReconciliationRepository["claimNext"]>[0],
  ) {
    if (!input.supportedProviderNames.includes(this.claim.provider)) return null;
    if (!this.pending) return null;
    this.pending = false;
    return {
      ...this.claim,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(Date.now() + input.leaseMilliseconds),
    };
  }

  async completePage(
    input: Parameters<MemoryReconciliationRepository["completePage"]>[0],
  ) {
    return defaultCommit(input.observations);
  }
}

function defaultCommit(
  observations: readonly MemoryReconciliationTargetObservation[],
): MemoryReconciliationPageCommit {
  const matched = observations.filter((item) => item.kind === "matched").length;
  const issues = observations.filter((item) =>
    item.kind === "missing"
    || item.kind === "hash_mismatch"
    || item.kind === "known_stale"
  ).length;
  const skipped = observations.filter((item) =>
    item.kind === "live_in_flight" || item.kind === "retained_inactive"
  ).length;
  const failed = observations.filter((item) => item.kind === "permanent_error").length;
  return {
    state: "partial",
    coverage: coverage({
      checked: matched + issues,
      matched,
      issues,
      skipped,
      failed,
    }),
  };
}

function coverage(
  input: Partial<MemoryReconciliationCoverage> = {},
): MemoryReconciliationCoverage {
  return {
    checked: input.checked ?? 0,
    total: input.total ?? 1,
    matched: input.matched ?? 0,
    issues: input.issues ?? 0,
    skipped: input.skipped ?? 0,
    retrying: input.retrying ?? 0,
    failed: input.failed ?? 0,
  };
}

function hashText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
