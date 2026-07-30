import {
  CreatorPayoutProfileStatus,
  PayoutDestinationStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  CreatorPayoutProfileError,
  activatePayoutDestinationLocally,
  createTokenizedPayoutDestination,
  disablePayoutDestinationLocally,
  getCreatorPayoutProfile,
  reviewCreatorPayoutProfileLocally,
  submitCreatorPayoutProfile,
  type CreatorPayoutProfileClient,
} from "../src/creator-payout-profiles";

const credentialEnv = {
  NODE_ENV: "test",
  PAYOUT_CREDENTIAL_MASTER_KEY:
    "cGF5b3V0LWRlc3RpbmF0aW9uLWtleS0wMDAwMDAwMSE=",
  PAYOUT_CREDENTIAL_MASTER_KEY_VERSION: "test-v1",
};
const initialNow = new Date("2026-07-29T08:00:00.000Z");

describe("creator payout profiles", () => {
  it("submits a personal profile idempotently and audits only safe metadata", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");

    const input = {
      ownerId: "owner-1",
      idempotencyKey: "submit-1",
    };
    const created = await submitCreatorPayoutProfile(input, {
      client: store.client,
    });
    const replay = await submitCreatorPayoutProfile(input, {
      client: store.client,
    });

    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      subjectType: "owner",
      status: "pending_verification",
      version: 0,
      destinations: [],
    });
    expect(store.profiles).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.payload).toEqual(
      expect.objectContaining({
        actorId: "owner-1",
        resourceId: created.id,
        status: "PENDING_VERIFICATION",
      }),
    );
    expect(JSON.stringify(store.audits)).not.toMatch(
      /token|ciphertext|fingerprint|accountNumber|identityDocument/i,
    );
  });

  it("stores one encrypted WeChat token but returns only safe destination fields", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const profile = await submitCreatorPayoutProfile(
      {
        ownerId: "owner-1",
        idempotencyKey: "submit-1",
      },
      { client: store.client },
    );
    const recipientToken = "wechat-provider-recipient-token-secret";

    const snapshot = await createTokenizedPayoutDestination(
      {
        ownerId: "owner-1",
        profileId: profile.id,
        recipientToken,
        providerMaskedLabel: "微信收款账户 · 尾号 **42",
        expectedProfileVersion: 0,
        idempotencyKey: "destination-1",
      },
      {
        client: store.client,
        env: credentialEnv,
        now: initialNow,
      },
    );

    expect(snapshot).toMatchObject({
      status: "pending_verification",
      version: 1,
      destinations: [
        {
          kind: "wechat_pay",
          status: "pending_verification",
          currency: "CNY",
          maskedLabel: "微信收款账户 · 尾号 **42",
        },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(recipientToken);
    expect(serialized).not.toMatch(
      /credential|ciphertext|authTag|fingerprint|recipientToken/i,
    );

    const stored = store.destinations[0]!;
    expect(stored.credentialCiphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored.credentialCiphertext).toString("utf8"))
      .not.toContain(recipientToken);
    expect(stored.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(store.audits.at(-1)?.payload)).not.toContain(
      recipientToken,
    );
    expect(JSON.stringify(store.audits.at(-1)?.payload)).not.toMatch(
      /fingerprint|ciphertext|maskedLabel/i,
    );
  });

  it("rejects raw-looking labels and conflicting idempotency replays", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const profile = await submitCreatorPayoutProfile(
      {
        ownerId: "owner-1",
        idempotencyKey: "submit-1",
      },
      { client: store.client },
    );

    await expect(
      createTokenizedPayoutDestination(
        {
          ownerId: "owner-1",
          profileId: profile.id,
          recipientToken: "provider-token-1",
          providerMaskedLabel: "6222020202020202020",
          expectedProfileVersion: 0,
          idempotencyKey: "destination-raw",
        },
        { client: store.client, env: credentialEnv },
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_invalid",
    });

    const firstInput = {
      ownerId: "owner-1",
      profileId: profile.id,
      recipientToken: "provider-token-1",
      providerMaskedLabel: "微信收款账户 · **01",
      expectedProfileVersion: 0,
      idempotencyKey: "destination-1",
    };
    await createTokenizedPayoutDestination(firstInput, {
      client: store.client,
      env: credentialEnv,
    });
    await expect(
      createTokenizedPayoutDestination(
        {
          ...firstInput,
          recipientToken: "provider-token-2",
        },
        { client: store.client, env: credentialEnv },
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_idempotency_conflict",
    });
    expect(store.destinations).toHaveLength(1);
  });

  it("reviews, activates, and cryptographically erases a disabled destination locally", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const pending = await createPendingDestination(store);
    const destinationId = pending.destinations[0]!.id;

    const reviewed = await reviewCreatorPayoutProfileLocally(
      {
        ownerId: "owner-1",
        profileId: pending.id,
        destinationId,
        decision: "approve",
        actorId: "local-operator-1",
        expectedProfileVersion: 1,
        idempotencyKey: "review-1",
      },
      {
        client: store.client,
        env: credentialEnv,
        now: initialNow,
      },
    );
    expect(reviewed).toMatchObject({
      status: "verified",
      version: 2,
      destinations: [
        {
          status: "verified",
          verifiedAt: initialNow.toISOString(),
        },
      ],
    });

    const active = await activatePayoutDestinationLocally(
      {
        ownerId: "owner-1",
        profileId: reviewed.id,
        destinationId,
        actorId: "local-operator-2",
        expectedProfileVersion: 2,
        idempotencyKey: "activate-1",
      },
      {
        client: store.client,
        env: credentialEnv,
        now: initialNow,
      },
    );
    expect(active).toMatchObject({
      status: "verified",
      version: 3,
      destinations: [{ status: "active" }],
    });

    const disabled = await disablePayoutDestinationLocally(
      {
        ownerId: "owner-1",
        profileId: active.id,
        destinationId,
        actorId: "local-operator-2",
        expectedProfileVersion: 3,
        idempotencyKey: "disable-1",
      },
      {
        client: store.client,
        env: credentialEnv,
        now: new Date(initialNow.getTime() + 1_000),
      },
    );
    expect(disabled).toMatchObject({
      status: "suspended",
      version: 4,
      destinations: [{ status: "disabled" }],
    });
    expect(store.destinations[0]).toMatchObject({
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
    });
  });

  it("keeps an active profile verified while a replacement destination is reviewed", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const pending = await createPendingDestination(store);
    const originalDestinationId = pending.destinations[0]!.id;
    const reviewed = await reviewCreatorPayoutProfileLocally(
      {
        ownerId: "owner-1",
        profileId: pending.id,
        destinationId: originalDestinationId,
        decision: "approve",
        actorId: "local-operator",
        expectedProfileVersion: 1,
        idempotencyKey: "review-original",
      },
      { client: store.client, env: credentialEnv, now: initialNow },
    );
    const active = await activatePayoutDestinationLocally(
      {
        ownerId: "owner-1",
        profileId: reviewed.id,
        destinationId: originalDestinationId,
        actorId: "local-operator",
        expectedProfileVersion: 2,
        idempotencyKey: "activate-original",
      },
      { client: store.client, env: credentialEnv, now: initialNow },
    );
    const replacementNow = new Date(initialNow.getTime() + 1_000);
    const replacement = await createTokenizedPayoutDestination(
      {
        ownerId: "owner-1",
        profileId: active.id,
        recipientToken: "wechat-provider-replacement-token",
        providerMaskedLabel: "微信收款账户 · **02",
        expectedProfileVersion: 3,
        idempotencyKey: "destination-replacement",
      },
      {
        client: store.client,
        env: credentialEnv,
        now: replacementNow,
      },
    );

    expect(replacement).toMatchObject({
      status: "verified",
      version: 4,
      verifiedAt: initialNow.toISOString(),
    });
    expect(
      replacement.destinations.find(
        (destination) => destination.id === originalDestinationId,
      ),
    ).toMatchObject({ status: "active" });
    const replacementDestination = replacement.destinations.find(
      (destination) => destination.maskedLabel.endsWith("**02"),
    );
    expect(replacementDestination).toMatchObject({
      status: "pending_verification",
      coolingOffUntil: new Date(
        replacementNow.getTime() + 24 * 60 * 60 * 1_000,
      ).toISOString(),
    });

    const replacementReviewNow = new Date(
      replacementNow.getTime() + 1_000,
    );
    const approvedReplacement =
      await reviewCreatorPayoutProfileLocally(
        {
          ownerId: "owner-1",
          profileId: replacement.id,
          destinationId: replacementDestination!.id,
          decision: "approve",
          actorId: "local-operator",
          expectedProfileVersion: 4,
          idempotencyKey: "review-replacement",
        },
        {
          client: store.client,
          env: credentialEnv,
          now: replacementReviewNow,
        },
      );
    expect(approvedReplacement).toMatchObject({
      status: "verified",
      version: 5,
      verifiedAt: initialNow.toISOString(),
    });
    expect(
      approvedReplacement.destinations.find(
        (destination) => destination.id === replacementDestination!.id,
      ),
    ).toMatchObject({
      status: "verified",
      verifiedAt: replacementReviewNow.toISOString(),
    });
    expect(
      approvedReplacement.destinations.find(
        (destination) => destination.id === originalDestinationId,
      ),
    ).toMatchObject({ status: "active" });
  });

  it("never permits local review, activation, or disabling in production", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const pending = await createPendingDestination(store);
    const common = {
      ownerId: "owner-1",
      profileId: pending.id,
      destinationId: pending.destinations[0]!.id,
      actorId: "local-operator",
      expectedProfileVersion: 1,
      idempotencyKey: "local-action",
    };
    const production = { ...credentialEnv, NODE_ENV: "production" };

    await expect(
      reviewCreatorPayoutProfileLocally(
        {
          ...common,
          decision: "approve",
        },
        { client: store.client, env: production },
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_local_only",
      statusCode: 404,
    });
    await expect(
      activatePayoutDestinationLocally(common, {
        client: store.client,
        env: production,
      }),
    ).rejects.toMatchObject({
      code: "payout_profile_local_only",
    });
    await expect(
      disablePayoutDestinationLocally(common, {
        client: store.client,
        env: production,
      }),
    ).rejects.toMatchObject({
      code: "payout_profile_local_only",
    });
  });

  it("resolves organization profiles only for matching billing members and limits mutations to owners/admins", async () => {
    const store = new FakePayoutProfileStore();
    store.addOrganizationOwner("owner-admin", "org-1", "ADMIN", true);
    store.addOrganizationOwner("owner-analyst", "org-1", "ANALYST", true);
    store.addOrganizationOwner("owner-denied", "org-1", "OWNER", false);

    const created = await submitCreatorPayoutProfile(
      {
        ownerId: "owner-admin",
        idempotencyKey: "org-submit",
      },
      { client: store.client },
    );
    expect(created.subjectType).toBe("organization");
    await expect(
      getCreatorPayoutProfile(
        { ownerId: "owner-analyst" },
        store.client,
      ),
    ).resolves.toMatchObject({
      id: created.id,
      subjectType: "organization",
    });
    await expect(
      submitCreatorPayoutProfile(
        {
          ownerId: "owner-analyst",
          idempotencyKey: "analyst-submit",
        },
        { client: store.client },
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_forbidden",
    });
    await expect(
      getCreatorPayoutProfile(
        { ownerId: "owner-denied" },
        store.client,
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_forbidden",
    });
  });

  it("blocks credential erasure while an active withdrawal pins the destination", async () => {
    const store = new FakePayoutProfileStore();
    store.addPersonalOwner("owner-1");
    const pending = await createPendingDestination(store);
    const destinationId = pending.destinations[0]!.id;
    const reviewed = await reviewCreatorPayoutProfileLocally(
      {
        ownerId: "owner-1",
        profileId: pending.id,
        destinationId,
        decision: "approve",
        actorId: "local-operator",
        expectedProfileVersion: 1,
        idempotencyKey: "review",
      },
      { client: store.client, env: credentialEnv, now: initialNow },
    );
    const active = await activatePayoutDestinationLocally(
      {
        ownerId: "owner-1",
        profileId: reviewed.id,
        destinationId,
        actorId: "local-operator",
        expectedProfileVersion: 2,
        idempotencyKey: "activate",
      },
      { client: store.client, env: credentialEnv, now: initialNow },
    );
    store.activeWithdrawalDestinationIds.add(destinationId);

    await expect(
      disablePayoutDestinationLocally(
        {
          ownerId: "owner-1",
          profileId: active.id,
          destinationId,
          actorId: "local-operator",
          expectedProfileVersion: 3,
          idempotencyKey: "disable",
        },
        { client: store.client, env: credentialEnv },
      ),
    ).rejects.toMatchObject({
      code: "payout_profile_state_conflict",
    });
    expect(store.destinations[0]?.credentialCiphertext).toBeInstanceOf(
      Uint8Array,
    );
  });
});

async function createPendingDestination(store: FakePayoutProfileStore) {
  const profile = await submitCreatorPayoutProfile(
    {
      ownerId: "owner-1",
      idempotencyKey: "submit",
    },
    { client: store.client },
  );
  return createTokenizedPayoutDestination(
    {
      ownerId: "owner-1",
      profileId: profile.id,
      recipientToken: "wechat-provider-recipient-token",
      providerMaskedLabel: "微信收款账户 · **01",
      expectedProfileVersion: 0,
      idempotencyKey: "destination",
    },
    {
      client: store.client,
      env: credentialEnv,
      now: initialNow,
    },
  );
}

class FakePayoutProfileStore {
  owners: Array<Record<string, any>> = [];
  profiles: Array<Record<string, any>> = [];
  destinations: Array<Record<string, any>> = [];
  audits: Array<Record<string, any>> = [];
  activeWithdrawalDestinationIds = new Set<string>();
  private sequence = 0;

  readonly client = this as unknown as CreatorPayoutProfileClient;

  addPersonalOwner(id: string) {
    this.owners.push({
      id,
      organizationId: null,
      organizationMember: null,
    });
  }

  addOrganizationOwner(
    id: string,
    organizationId: string,
    role: "OWNER" | "ADMIN" | "APPROVER" | "ANALYST",
    canManageBilling: boolean,
  ) {
    this.owners.push({
      id,
      organizationId,
      organizationMember: {
        organizationId,
        role,
        canManageBilling,
      },
    });
  }

  owner = {
    findUnique: async (args: any) =>
      this.owners.find((owner) => owner.id === args.where.id) ?? null,
  };

  creatorPayoutProfile = {
    findUnique: async (args: any) => {
      const profile = this.profiles.find((candidate) =>
        args.where.id
          ? candidate.id === args.where.id
          : args.where.ownerId
            ? candidate.ownerId === args.where.ownerId
            : candidate.organizationId === args.where.organizationId,
      );
      return profile ? this.withDestinations(profile, args.select) : null;
    },
    create: async (args: any) => {
      const now = new Date(initialNow);
      const profile = {
        id: args.data.id ?? `profile-${++this.sequence}`,
        ownerId: null,
        organizationId: null,
        status: CreatorPayoutProfileStatus.PENDING_VERIFICATION,
        version: 0,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReasonCode: null,
        suspendedAt: null,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      this.profiles.push(profile);
      return this.withDestinations(profile, args.select);
    },
    update: async (args: any) => {
      const profile = this.requireProfile(args.where.id);
      applyData(profile, args.data);
      profile.updatedAt = new Date(initialNow);
      return this.withDestinations(profile, args.select);
    },
    updateMany: async (args: any) => {
      const profile = this.profiles.find(
        (candidate) =>
          candidate.id === args.where.id
          && candidate.version === args.where.version,
      );
      if (!profile) return { count: 0 };
      applyData(profile, args.data);
      profile.updatedAt = new Date(initialNow);
      return { count: 1 };
    },
  };

  payoutDestination = {
    findUnique: async (args: any) =>
      this.destinations.find(
        (destination) => destination.id === args.where.id,
      ) ?? null,
    findMany: async (args: any) => {
      const rows = this.destinations.filter((destination) =>
        matchesDestinationWhere(destination, args.where),
      );
      if (args.orderBy?.[0]?.credentialVersion === "desc") {
        rows.sort(
          (left, right) =>
            right.credentialVersion - left.credentialVersion
            || right.id.localeCompare(left.id),
        );
      }
      return rows;
    },
    create: async (args: any) => {
      const now = new Date(initialNow);
      const destination = {
        verifiedAt: null,
        verifiedBy: null,
        activatedAt: null,
        disabledAt: null,
        replacedAt: null,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      this.destinations.push(destination);
      return destination;
    },
    update: async (args: any) => {
      const destination = this.requireDestination(args.where.id);
      applyData(destination, args.data);
      destination.updatedAt = new Date(initialNow);
      return destination;
    },
    updateMany: async (args: any) => {
      const rows = this.destinations.filter((destination) =>
        matchesDestinationWhere(destination, args.where),
      );
      for (const row of rows) applyData(row, args.data);
      return { count: rows.length };
    },
  };

  withdrawRequest = {
    count: async (args: any) =>
      this.activeWithdrawalDestinationIds.has(
        args.where.payoutDestinationId,
      )
        ? 1
        : 0,
  };

  eventAudit = {
    findUnique: async (args: any) => {
      const key = args.where.ownerId_idempotencyKey;
      return this.audits.find(
        (audit) =>
          audit.ownerId === key.ownerId
          && audit.idempotencyKey === key.idempotencyKey,
      ) ?? null;
    },
    create: async (args: any) => {
      if (
        this.audits.some(
          (audit) =>
            audit.ownerId === args.data.ownerId
            && audit.idempotencyKey === args.data.idempotencyKey,
        )
      ) {
        throw new Error("duplicate audit");
      }
      const audit = {
        id: `audit-${++this.sequence}`,
        ...args.data,
      };
      this.audits.push(audit);
      return audit;
    },
  };

  $transaction = async <T>(
    operation: (tx: CreatorPayoutProfileClient) => Promise<T>,
  ) => operation(this.client);

  private requireProfile(id: string) {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error("profile not found");
    return profile;
  }

  private requireDestination(id: string) {
    const destination = this.destinations.find(
      (candidate) => candidate.id === id,
    );
    if (!destination) throw new Error("destination not found");
    return destination;
  }

  private withDestinations(profile: Record<string, any>, select: any) {
    const rows = this.destinations
      .filter((destination) => destination.profileId === profile.id)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime()
          || right.id.localeCompare(left.id),
      );
    if (!select?.destinations) return { ...profile };
    return {
      ...profile,
      destinations: rows,
    };
  }
}

function applyData(record: Record<string, any>, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && "increment" in value
    ) {
      record[key] = (record[key] ?? 0) + value.increment;
    } else {
      record[key] = value;
    }
  }
}

function matchesDestinationWhere(
  destination: Record<string, any>,
  where: Record<string, any> | undefined,
) {
  if (!where) return true;
  if (where.profileId && destination.profileId !== where.profileId) {
    return false;
  }
  if (
    where.id?.not
    && destination.id === where.id.not
  ) {
    return false;
  }
  if (
    typeof where.status === "string"
    && destination.status !== where.status
  ) {
    return false;
  }
  return true;
}
