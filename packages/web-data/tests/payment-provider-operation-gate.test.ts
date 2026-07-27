import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  claimPaymentProviderOperation,
  createPaymentProviderOperationScopeKey,
  releasePaymentProviderOperation,
  type PaymentProviderOperationGateClient,
} from "../src/payment-provider-operation-gate";

describe("payment provider operation gate", () => {
  it("hashes canonical scope parts without retaining their raw identity", () => {
    const first = createPaymentProviderOperationScopeKey([
      "wechat_pay",
      "recharge_create",
      "audience-identity-secret",
    ]);
    const replay = createPaymentProviderOperationScopeKey([
      "wechat_pay",
      "recharge_create",
      "audience-identity-secret",
    ]);
    const otherIdentity = createPaymentProviderOperationScopeKey([
      "wechat_pay",
      "recharge_create",
      "another-identity",
    ]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(replay);
    expect(first).not.toBe(otherIdentity);
    expect(first).not.toContain("audience-identity-secret");
  });

  it("claims with one atomic upsert using database time", async () => {
    const scopeKey = "a".repeat(64);
    const leaseToken = "lease-token-1";
    const leaseExpiresAt = new Date("2026-07-27T12:00:15.000Z");
    const nextAllowedAt = new Date("2026-07-27T12:00:10.000Z");
    const client = new FakeGateClient([
      [{
        scopeKey,
        leaseToken,
        leaseExpiresAt,
        nextAllowedAt,
      }],
    ]);

    await expect(
      claimPaymentProviderOperation(
        {
          scopeKey,
          leaseToken,
        },
        client,
      ),
    ).resolves.toEqual({
      claimed: true,
      scopeKey,
      leaseToken,
      leaseExpiresAt,
      nextAllowedAt,
    });

    expect(client.queries).toHaveLength(1);
    const query = sqlText(client.queries[0]!);
    expect(query).toContain(
      'INSERT INTO "PaymentProviderOperationGate" AS gate',
    );
    expect(query).toContain('ON CONFLICT ("scopeKey") DO UPDATE');
    expect(query).toContain('gate."leaseExpiresAt" <= NOW()');
    expect(query).toContain('gate."nextAllowedAt" <= NOW()');
    expect(query).toContain('"updatedAt" = NOW()');
    expect(client.queries[0]?.values).toEqual([
      scopeKey,
      leaseToken,
      15_000,
      10_000,
    ]);
  });

  it("returns the database retry delay when another caller owns the gate", async () => {
    const scopeKey = "b".repeat(64);
    const client = new FakeGateClient([
      [],
      [{ retryAfterSeconds: 8 }],
    ]);

    await expect(
      claimPaymentProviderOperation({ scopeKey }, client),
    ).resolves.toEqual({
      claimed: false,
      scopeKey,
      retryAfterSeconds: 8,
    });

    expect(client.queries).toHaveLength(2);
    expect(sqlText(client.queries[1]!)).toContain("GREATEST( 1,");
    expect(sqlText(client.queries[1]!)).toContain("- NOW()");
  });

  it("releases only the matching fencing token", async () => {
    const scopeKey = "c".repeat(64);
    const activeClient = new FakeGateClient([], [1]);
    const staleClient = new FakeGateClient([], [0]);

    await expect(
      releasePaymentProviderOperation(
        { scopeKey, leaseToken: "active-token" },
        activeClient,
      ),
    ).resolves.toBe(true);
    await expect(
      releasePaymentProviderOperation(
        { scopeKey, leaseToken: "stale-token" },
        staleClient,
      ),
    ).resolves.toBe(false);

    const releaseQuery = activeClient.executions[0]!;
    expect(sqlText(releaseQuery)).toContain(
      'AND "leaseToken" = ?',
    );
    expect(releaseQuery.values).toEqual([scopeKey, "active-token"]);
    expect(sqlText(releaseQuery)).not.toContain('"nextAllowedAt" =');
  });

  it("rejects raw scope identifiers before touching storage", async () => {
    const client = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    } as unknown as PaymentProviderOperationGateClient;

    await expect(
      claimPaymentProviderOperation(
        { scopeKey: "audience-identity-secret" },
        client,
      ),
    ).rejects.toThrow("SHA-256");
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});

class FakeGateClient implements PaymentProviderOperationGateClient {
  readonly queries: Prisma.Sql[] = [];
  readonly executions: Prisma.Sql[] = [];

  constructor(
    private readonly queryResults: unknown[][],
    private readonly executeResults: number[] = [],
  ) {}

  async $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> {
    this.queries.push(query);
    return (this.queryResults.shift() ?? []) as T;
  }

  async $executeRaw(query: Prisma.Sql): Promise<number> {
    this.executions.push(query);
    return this.executeResults.shift() ?? 0;
  }
}

function sqlText(query: Prisma.Sql): string {
  return query.sql.replace(/\s+/g, " ").trim();
}
