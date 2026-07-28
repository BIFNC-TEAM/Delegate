import { describe, expect, it } from "vitest";

import {
  buildWebAudienceKey,
  buildWebAudienceExternalUserId,
  buildWebChannelUserId,
  linkAudienceIdentity,
  loadWebConversationRecentTurns,
  mergeAudienceIdentity,
  persistWebConversationExchange,
  resolveAnonymousAudienceIdentity,
  resolveAuthenticatedAudienceIdentity,
  resolveCanonicalAudienceIdentity,
  resolveChannelAudienceIdentity,
  resolveWebAudienceConversation,
  resolveWebAudienceContact,
} from "../src/web-audience";

describe("web audience identity resolver", () => {
  it("upserts one contact per representative/audience pair", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );
    const second = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.contacts).toHaveLength(1);
    expect(client.contacts[0]).toMatchObject({
      representativeId: "rep-1",
      audienceIdentityId: "identity-1",
      telegramUserId: "web:aud_123",
      channelUserId: "web:aud_123",
      source: "web",
      sourceChannel: "web",
    });
    expect(client.audienceIdentities).toHaveLength(1);
    expect(client.identityLinks[0]).toMatchObject({
      audienceIdentityId: "identity-1",
      provider: "WEB_ANONYMOUS",
      providerSubject: "web:aud_123",
    });
  });

  it("keeps the same anonymous audience isolated between representatives", async () => {
    const client = new FakeWebAudienceClient();

    await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lao-jia",
        audienceId: "aud_123",
      },
      client,
    );
    await resolveWebAudienceContact(
      {
        representativeId: "rep-2",
        representativeSlug: "lin",
        audienceId: "aud_123",
      },
      client,
    );

    expect(client.contacts).toHaveLength(2);
    expect(client.contacts.map((contact) => contact.representativeId)).toEqual(["rep-1", "rep-2"]);
  });

  it("normalizes web audience identifiers for contact and wallet use", () => {
    expect(buildWebAudienceKey("aud_ABC")).toBe("web:aud_abc");
    expect(buildWebChannelUserId("aud_ABC")).toBe("web:aud_abc");
    expect(buildWebAudienceExternalUserId("lao-jia", "aud_ABC")).toBe("web:lao-jia:aud_abc");
  });

  it("resolves a stable anonymous audience identity and web identity link", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_123",
        now: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );
    const second = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "AUD_123",
        now: new Date("2026-07-04T12:05:00.000Z"),
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.audienceIdentities).toEqual([
      expect.objectContaining({
        id: "identity-1",
        audienceKey: "web:aud_123",
        status: "ANONYMOUS",
        lastSeenAt: new Date("2026-07-04T12:05:00.000Z"),
      }),
    ]);
    expect(client.identityLinks).toEqual([
      expect.objectContaining({
        audienceIdentityId: "identity-1",
        provider: "WEB_ANONYMOUS",
        providerSubject: "web:aud_123",
      }),
    ]);
  });

  it("links external identities to an audience identity", async () => {
    const client = new FakeWebAudienceClient();
    const identity = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_123",
      },
      client,
    );

    await linkAudienceIdentity(
      {
        audienceIdentityId: identity.id,
        provider: "EMAIL",
        providerSubject: "Ada@Example.COM ",
        verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );

    expect(client.identityLinks).toContainEqual(
      expect.objectContaining({
        audienceIdentityId: identity.id,
        provider: "EMAIL",
        providerSubject: "ada@example.com",
        verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      }),
    );
  });

  it("locks channel identity resolution to the verified provider connection", async () => {
    const client = new FakeWebAudienceClient();

    const identity = await resolveChannelAudienceIdentity(
      {
        provider: "TELEGRAM",
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "111",
      },
      client,
    );

    await expect(
      resolveChannelAudienceIdentity(
        {
          provider: "TELEGRAM",
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "222",
        },
        client,
      ),
    ).rejects.toThrow(/not actively verified/i);
    expect(client.audienceIdentities).toHaveLength(1);
    expect(identity.id).toBe(client.identityLinks[0]?.audienceIdentityId);
  });

  it("does not let ordinary channel traffic create or restore a connection proof", async () => {
    const client = new FakeWebAudienceClient();

    await resolveChannelAudienceIdentity(
      {
        provider: "TELEGRAM",
        providerSubject: "123456",
        issuer: "delegate-managed-bot",
        connectionId: "bot-a",
      },
      client,
    );
    const botAProof = client.identityLinkConnectionProofs.find(
      (proof) => proof.connectionId === "bot-a",
    );
    expect(botAProof).toBeDefined();
    botAProof!.revokedAt = new Date("2026-07-28T00:00:00.000Z");

    await expect(
      resolveChannelAudienceIdentity(
        {
          provider: "TELEGRAM",
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "bot-a",
        },
        client,
      ),
    ).rejects.toThrow(/not actively verified/i);
    await expect(
      resolveChannelAudienceIdentity(
        {
          provider: "TELEGRAM",
          providerSubject: "123456",
          issuer: "delegate-managed-bot",
          connectionId: "bot-b",
        },
        client,
      ),
    ).rejects.toThrow(/not actively verified/i);

    expect(client.identityLinkConnectionProofs).toHaveLength(1);
    expect(botAProof?.revokedAt).toEqual(
      new Date("2026-07-28T00:00:00.000Z"),
    );
  });

  it("merges anonymous identity references into a target identity", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_source",
      },
      client,
    );
    const target = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_target",
      },
      client,
    );
    client.contacts.push(buildContactRow({ id: "contact-source", audienceIdentityId: source.id }));
    client.conversations.push(
      buildConversationRow({ id: "conversation-source", audienceIdentityId: source.id }),
    );
    client.userWallets.push({ id: "wallet-source", audienceIdentityId: source.id });
    client.sandboxIdentities.push({ id: "sandbox-source", audienceIdentityId: source.id });
    client.memoryRecords.push({ id: "memory-source", audienceIdentityId: source.id });
    client.delegationTasks.push({ id: "task-source", audienceIdentityId: source.id });
    registerIdentity(client, target.id);

    await mergeAudienceIdentity(
      {
        sourceAudienceIdentityId: source.id,
        targetAudienceIdentityId: target.id,
        now: new Date("2026-07-04T12:30:00.000Z"),
      },
      client,
    );

    expect(client.contacts[0]?.audienceIdentityId).toBe(target.id);
    expect(client.conversations[0]?.audienceIdentityId).toBe(target.id);
    expect(client.userWallets[0]?.audienceIdentityId).toBe(target.id);
    expect(client.sandboxIdentities[0]?.audienceIdentityId).toBe(target.id);
    expect(client.memoryRecords[0]?.audienceIdentityId).toBe(target.id);
    expect(client.delegationTasks[0]?.audienceIdentityId).toBe(target.id);
    expect(client.identityLinks.every((link) => link.audienceIdentityId !== source.id)).toBe(true);
    expect(client.audienceIdentities.find((identity) => identity.id === source.id)).toMatchObject({
      status: "MERGED",
      mergedIntoId: target.id,
      lastSeenAt: new Date("2026-07-04T12:30:00.000Z"),
    });
  });

  it("merges the current anonymous identity into an existing authenticated identity", async () => {
    const client = new FakeWebAudienceClient();
    const anonymous = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_anonymous",
      },
      client,
    );
    const registered = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_registered",
      },
      client,
    );
    client.identityLinks.push({
      id: "identity-link-logto",
      audienceIdentityId: registered.id,
      provider: "LOGTO",
      providerSubject: "LogtoUserA",
      issuer: null,
      connectionId: null,
      verifiedAt: new Date("2026-07-04T12:00:00.000Z"),
      metadata: null,
    });
    client.contacts.push(buildContactRow({ id: "contact-anonymous", audienceIdentityId: anonymous.id }));
    client.conversations.push(
      buildConversationRow({ id: "conversation-anonymous", audienceIdentityId: anonymous.id }),
    );
    client.userWallets.push({ id: "wallet-anonymous", audienceIdentityId: anonymous.id });
    client.sandboxIdentities.push({ id: "sandbox-anonymous", audienceIdentityId: anonymous.id });
    client.memoryRecords.push({ id: "memory-anonymous", audienceIdentityId: anonymous.id });

    const result = await resolveAuthenticatedAudienceIdentity(
      {
        audienceIdentityId: anonymous.id,
        provider: "LOGTO",
        providerSubject: "LogtoUserA",
        verifiedAt: new Date("2026-07-04T13:00:00.000Z"),
        now: new Date("2026-07-04T13:00:00.000Z"),
      },
      client,
    );

    expect(result.id).toBe(registered.id);
    expect(client.contacts[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.conversations[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.userWallets[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.sandboxIdentities[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.memoryRecords[0]?.audienceIdentityId).toBe(registered.id);
    expect(client.audienceIdentities.find((identity) => identity.id === anonymous.id)).toMatchObject({
      status: "MERGED",
      mergedIntoId: registered.id,
    });
    expect(client.audienceIdentities.find((identity) => identity.id === registered.id)).toMatchObject({
      status: "REGISTERED",
      lastSeenAt: new Date("2026-07-04T13:00:00.000Z"),
    });
  });

  it("rejects a revoked authenticated identity link without restoring or merging it", async () => {
    const client = new FakeWebAudienceClient();
    const current = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_revoked_current",
      },
      client,
    );
    const registered = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_revoked_registered",
      },
      client,
    );
    registerIdentity(client, registered.id);
    const revokedAt = new Date("2026-07-04T12:30:00.000Z");
    const originalVerifiedAt = new Date("2026-07-04T12:00:00.000Z");
    client.identityLinks.push({
      id: "identity-link-revoked-logto",
      audienceIdentityId: registered.id,
      provider: "LOGTO",
      providerSubject: "RevokedLogtoUser",
      issuer: null,
      connectionId: null,
      verifiedAt: originalVerifiedAt,
      revokedAt,
      metadata: null,
    });

    await expect(
      resolveAuthenticatedAudienceIdentity(
        {
          audienceIdentityId: current.id,
          provider: "LOGTO",
          providerSubject: "RevokedLogtoUser",
          verifiedAt: new Date("2026-07-04T13:00:00.000Z"),
          now: new Date("2026-07-04T13:00:00.000Z"),
        },
        client,
      ),
    ).rejects.toThrow(/authenticated identity link has been revoked/i);

    expect(client.audienceIdentities.find((identity) => identity.id === current.id)).toMatchObject({
      status: "ANONYMOUS",
      mergedIntoId: null,
    });
    expect(
      client.identityLinks.find((link) => link.id === "identity-link-revoked-logto"),
    ).toMatchObject({
      audienceIdentityId: registered.id,
      verifiedAt: originalVerifiedAt,
      revokedAt,
    });
  });

  it("keeps contacts attached to the merged target on later anonymous cookie reuse", async () => {
    const client = new FakeWebAudienceClient();
    const contact = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lin",
        audienceId: "aud_cookie",
      },
      client,
    );
    const target = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_logged_in",
      },
      client,
    );
    registerIdentity(client, target.id);

    await mergeAudienceIdentity(
      {
        sourceAudienceIdentityId: contact.audienceIdentityId!,
        targetAudienceIdentityId: target.id,
        now: new Date("2026-07-04T13:00:00.000Z"),
      },
      client,
    );
    const reused = await resolveWebAudienceContact(
      {
        representativeId: "rep-1",
        representativeSlug: "lin",
        audienceId: "aud_cookie",
        now: new Date("2026-07-04T13:05:00.000Z"),
      },
      client,
    );

    expect(reused.id).toBe(contact.id);
    expect(reused.audienceIdentityId).toBe(target.id);
  });

  it("rejects silently reassigning an identity provider subject", async () => {
    const client = new FakeWebAudienceClient();
    const first = await resolveAnonymousAudienceIdentity({ audienceId: "aud_first" }, client);
    const second = await resolveAnonymousAudienceIdentity({ audienceId: "aud_second" }, client);

    await linkAudienceIdentity(
      {
        audienceIdentityId: first.id,
        provider: "EMAIL",
        providerSubject: "owner@example.com",
      },
      client,
    );

    await expect(
      linkAudienceIdentity(
        {
          audienceIdentityId: second.id,
          provider: "EMAIL",
          providerSubject: "owner@example.com",
        },
        client,
      ),
    ).rejects.toThrow(/already linked to another audience identity/i);
    expect(
      client.identityLinks.find(
        (link) => link.provider === "EMAIL" && link.providerSubject === "owner@example.com",
      )?.audienceIdentityId,
    ).toBe(first.id);
  });

  it("allows only one winner when provider subjects are linked concurrently", async () => {
    const client = new FakeWebAudienceClient();
    const first = await resolveAnonymousAudienceIdentity({ audienceId: "aud_first" }, client);
    const second = await resolveAnonymousAudienceIdentity({ audienceId: "aud_second" }, client);

    const results = await Promise.allSettled([
      linkAudienceIdentity(
        {
          audienceIdentityId: first.id,
          provider: "EMAIL",
          providerSubject: "race@example.com",
        },
        client,
      ),
      linkAudienceIdentity(
        {
          audienceIdentityId: second.id,
          provider: "EMAIL",
          providerSubject: "race@example.com",
        },
        client,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      client.identityLinks.filter(
        (link) => link.provider === "EMAIL" && link.providerSubject === "race@example.com",
      ),
    ).toHaveLength(1);
  });

  it("rejects automatic registered-to-registered account merges", async () => {
    const client = new FakeWebAudienceClient();
    const current = await resolveAnonymousAudienceIdentity({ audienceId: "aud_current" }, client);
    const existing = await resolveAnonymousAudienceIdentity({ audienceId: "aud_existing" }, client);
    registerIdentity(client, current.id);
    registerIdentity(client, existing.id);
    await linkAudienceIdentity(
      {
        audienceIdentityId: existing.id,
        provider: "LOGTO",
        providerSubject: "logto-account",
      },
      client,
    );

    await expect(
      resolveAuthenticatedAudienceIdentity(
        {
          audienceIdentityId: current.id,
          provider: "LOGTO",
          providerSubject: "logto-account",
        },
        client,
      ),
    ).rejects.toThrow(/registered-to-registered merge is not allowed/i);
    expect(client.audienceIdentities.find((identity) => identity.id === current.id)).toMatchObject({
      status: "REGISTERED",
      mergedIntoId: null,
    });
  });

  it("resolves multi-hop merged identities to their canonical registered identity", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const middle = await resolveAnonymousAudienceIdentity({ audienceId: "aud_middle" }, client);
    const target = await resolveAnonymousAudienceIdentity({ audienceId: "aud_target" }, client);
    setIdentityState(client, source.id, "MERGED", middle.id);
    setIdentityState(client, middle.id, "MERGED", target.id);
    registerIdentity(client, target.id);

    const canonical = await resolveCanonicalAudienceIdentity(
      { audienceIdentityId: source.id },
      client,
    );
    const reused = await resolveAnonymousAudienceIdentity(
      {
        audienceId: "aud_source",
        now: new Date("2026-07-04T15:00:00.000Z"),
      },
      client,
    );

    expect(canonical.id).toBe(target.id);
    expect(reused.id).toBe(target.id);
    expect(reused.lastSeenAt).toEqual(new Date("2026-07-04T15:00:00.000Z"));
    expect(
      client.identityLinks.find(
        (link) => link.provider === "WEB_ANONYMOUS" && link.providerSubject === "web:aud_source",
      )?.audienceIdentityId,
    ).toBe(target.id);
  });

  it("rejects cyclic and disabled canonical identity chains", async () => {
    const cycleClient = new FakeWebAudienceClient();
    const first = await resolveAnonymousAudienceIdentity({ audienceId: "aud_first" }, cycleClient);
    const second = await resolveAnonymousAudienceIdentity({ audienceId: "aud_second" }, cycleClient);
    setIdentityState(cycleClient, first.id, "MERGED", second.id);
    setIdentityState(cycleClient, second.id, "MERGED", first.id);

    await expect(
      resolveCanonicalAudienceIdentity({ audienceIdentityId: first.id }, cycleClient),
    ).rejects.toThrow(/merge cycle detected/i);

    const disabledClient = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, disabledClient);
    const disabled = await resolveAnonymousAudienceIdentity(
      { audienceId: "aud_disabled" },
      disabledClient,
    );
    setIdentityState(disabledClient, source.id, "MERGED", disabled.id);
    setIdentityState(disabledClient, disabled.id, "DISABLED", null);

    await expect(
      resolveCanonicalAudienceIdentity({ audienceIdentityId: source.id }, disabledClient),
    ).rejects.toThrow(/is disabled/i);
  });

  it("rejects automatic merges when both identities own wallets", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const target = await resolveAnonymousAudienceIdentity({ audienceId: "aud_target" }, client);
    registerIdentity(client, target.id);
    client.userWallets.push(
      { id: "wallet-source", audienceIdentityId: source.id },
      { id: "wallet-target", audienceIdentityId: target.id },
    );

    await expect(
      mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: source.id,
          targetAudienceIdentityId: target.id,
        },
        client,
      ),
    ).rejects.toThrow(/both identities own wallets/i);
    expect(client.userWallets.map((wallet) => wallet.audienceIdentityId)).toEqual([
      source.id,
      target.id,
    ]);
    expect(client.audienceIdentities.find((identity) => identity.id === source.id)).toMatchObject({
      status: "ANONYMOUS",
      mergedIntoId: null,
    });
  });

  it("transfers proof-gated provisional entitlements and payment history once", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const target = await resolveAnonymousAudienceIdentity({ audienceId: "aud_target" }, client);
    registerIdentity(client, target.id);
    client.serviceEntitlementAccounts.push({
      id: "entitlement-source",
      audienceIdentityId: source.id,
      representativeId: "rep-1",
      productCode: "telegram:plan:starter",
    });
    client.servicePaymentOrders.push({
      id: "payment-source",
      payerAudienceIdentityId: source.id,
    });
    client.agentTokenPurchases.push({
      id: "purchase-source",
      audienceIdentityId: source.id,
    });
    client.agentUsageCharges.push({
      id: "usage-source",
      audienceIdentityId: source.id,
    });

    await mergeAudienceIdentity(
      {
        sourceAudienceIdentityId: source.id,
        targetAudienceIdentityId: target.id,
        transferVerifiedProvisionalAssets: true,
      },
      client,
    );

    expect(client.serviceEntitlementAccounts[0]?.audienceIdentityId).toBe(target.id);
    expect(client.servicePaymentOrders[0]?.payerAudienceIdentityId).toBe(target.id);
    expect(client.agentTokenPurchases[0]?.audienceIdentityId).toBe(target.id);
    expect(client.agentUsageCharges[0]?.audienceIdentityId).toBe(target.id);
  });

  it("does not combine two entitlement balances during provisional identity binding", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const target = await resolveAnonymousAudienceIdentity({ audienceId: "aud_target" }, client);
    registerIdentity(client, target.id);
    client.serviceEntitlementAccounts.push(
      {
        id: "entitlement-source",
        audienceIdentityId: source.id,
        representativeId: "rep-1",
        productCode: "plan:starter",
      },
      {
        id: "entitlement-target",
        audienceIdentityId: target.id,
        representativeId: "rep-1",
        productCode: "plan:starter",
      },
    );

    await expect(
      mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: source.id,
          targetAudienceIdentityId: target.id,
          transferVerifiedProvisionalAssets: true,
        },
        client,
      ),
    ).rejects.toThrow(/explicit balance consolidation is required/i);
    expect(client.serviceEntitlementAccounts[0]?.audienceIdentityId).toBe(source.id);
    expect(client.audienceIdentities.find((identity) => identity.id === source.id)).toMatchObject({
      status: "ANONYMOUS",
      mergedIntoId: null,
    });
  });

  it("rejects merging an anonymous identity into another anonymous identity", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const target = await resolveAnonymousAudienceIdentity({ audienceId: "aud_target" }, client);

    await expect(
      mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: source.id,
          targetAudienceIdentityId: target.id,
        },
        client,
      ),
    ).rejects.toThrow(/only be merged into a registered identity/i);
  });

  it("allows only one target to claim an anonymous identity concurrently", async () => {
    const client = new FakeWebAudienceClient();
    const source = await resolveAnonymousAudienceIdentity({ audienceId: "aud_source" }, client);
    const firstTarget = await resolveAnonymousAudienceIdentity(
      { audienceId: "aud_first_target" },
      client,
    );
    const secondTarget = await resolveAnonymousAudienceIdentity(
      { audienceId: "aud_second_target" },
      client,
    );
    registerIdentity(client, firstTarget.id);
    registerIdentity(client, secondTarget.id);
    client.delegationTasks.push({ id: "task-source", audienceIdentityId: source.id });

    const results = await Promise.allSettled([
      mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: source.id,
          targetAudienceIdentityId: firstTarget.id,
        },
        client,
      ),
      mergeAudienceIdentity(
        {
          sourceAudienceIdentityId: source.id,
          targetAudienceIdentityId: secondTarget.id,
        },
        client,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const merged = client.audienceIdentities.find((identity) => identity.id === source.id);
    expect(merged?.status).toBe("MERGED");
    expect([firstTarget.id, secondTarget.id]).toContain(merged?.mergedIntoId);
    expect(client.delegationTasks[0]?.audienceIdentityId).toBe(merged?.mergedIntoId);
  });

  it("creates one conversation per web audience contact", async () => {
    const client = new FakeWebAudienceClient();

    const first = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );
    const second = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );

    expect(first.id).toBe(second.id);
    expect(client.conversations).toHaveLength(1);
    expect(client.conversations[0]).toMatchObject({
      representativeId: "rep-1",
      contactId: "contact-1",
      audienceIdentityId: "identity-1",
      telegramChatId: "web:aud_123",
      channelThreadId: "web:aud_123",
      channel: "PRIVATE_CHAT",
      sourceChannel: "web",
      freeRepliesUsed: 0,
    });
  });

  it("persists each web chat exchange and increments free usage", async () => {
    const client = new FakeWebAudienceClient();
    const conversation = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );

    const updated = await persistWebConversationExchange(
      {
        conversationId: conversation.id,
        userMessage: "hello",
        assistantMessage: "hi there",
        intent: "faq",
        nextStep: "answer",
        now: new Date("2026-07-04T12:00:00.000Z"),
      },
      client,
    );

    expect(updated.freeRepliesUsed).toBe(1);
    expect(client.turns).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        direction: "inbound",
        messageText: "hello",
      }),
      expect.objectContaining({
        conversationId: conversation.id,
        direction: "outbound",
        messageText: "hi there",
        intent: "faq",
        summary: "answer",
      }),
    ]);
  });

  it("loads bounded recent turns from the current conversation only", async () => {
    const client = new FakeWebAudienceClient();
    const conversation = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-1",
        audienceId: "aud_123",
      },
      client,
    );
    const other = await resolveWebAudienceConversation(
      {
        representativeId: "rep-1",
        contactId: "contact-2",
        audienceId: "aud_456",
      },
      client,
    );

    for (let index = 0; index < 10; index += 1) {
      client.turns.push({
        id: `turn-${index}`,
        conversationId: conversation.id,
        direction: index % 2 === 0 ? "inbound" : "outbound",
        messageText: index === 9 ? "x".repeat(300) : `message-${index}`,
        intent: null,
        summary: null,
        createdAt: new Date(`2026-07-04T12:00:${String(index).padStart(2, "0")}.000Z`),
      });
    }
    client.turns.push({
      id: "other-turn",
      conversationId: other.id,
      direction: "inbound",
      messageText: "do not leak",
      intent: null,
      summary: null,
      createdAt: new Date("2026-07-04T12:01:00.000Z"),
    });

    const turns = await loadWebConversationRecentTurns(
      {
        conversationId: conversation.id,
      },
      client,
    );

    expect(turns).toHaveLength(8);
    expect(turns[0]?.messageText).toBe("message-2");
    expect(turns.at(-1)?.messageText).toHaveLength(240);
    expect(turns.map((turn) => turn.messageText)).not.toContain("do not leak");
  });
});

type ContactRow = {
  id: string;
  representativeId: string;
  audienceIdentityId: string | null;
  telegramUserId: string;
  channelUserId: string | null;
  username: string | null;
  displayName: string | null;
  source: string | null;
  sourceChannel: string | null;
  lastSeenAt: Date;
};

type ConversationRow = {
  id: string;
  representativeId: string;
  contactId: string;
  audienceIdentityId: string | null;
  telegramChatId: string;
  channelThreadId: string | null;
  channel: string;
  sourceChannel: string | null;
  state: string;
  freeRepliesUsed: number;
  lastMessageAt: Date;
};

type TurnRow = {
  id: string;
  conversationId: string;
  direction: string;
  messageText: string;
  intent: string | null;
  summary: string | null;
  createdAt: Date;
};

type AudienceIdentityRow = {
  id: string;
  audienceKey: string;
  status: string;
  mergedIntoId: string | null;
  lastSeenAt: Date;
};

type IdentityLinkRow = {
  id: string;
  audienceIdentityId: string;
  provider: string;
  providerSubject: string;
  issuer: string | null;
  connectionId: string | null;
  verifiedAt: Date | null;
  revokedAt?: Date | null;
  metadata: unknown;
};

type IdentityLinkConnectionProofRow = {
  identityLinkId: string;
  issuer: string;
  connectionId: string;
  verifiedAt: Date | null;
  assuranceLevel: "UNVERIFIED" | "PLATFORM_VERIFIED" | "STEP_UP_VERIFIED";
  revokedAt: Date | null;
  proofMetadata: unknown;
};

class FakeWebAudienceClient {
  audienceIdentities: AudienceIdentityRow[] = [];
  identityLinks: IdentityLinkRow[] = [];
  identityLinkConnectionProofs: IdentityLinkConnectionProofRow[] = [];
  contacts: ContactRow[] = [];
  conversations: ConversationRow[] = [];
  turns: TurnRow[] = [];
  userWallets: Array<{ id: string; audienceIdentityId: string | null }> = [];
  sandboxIdentities: Array<{ id: string; audienceIdentityId: string | null }> = [];
  memoryRecords: Array<{ id: string; audienceIdentityId: string | null }> = [];
  delegationTasks: Array<{ id: string; audienceIdentityId: string | null }> = [];
  serviceEntitlementAccounts: Array<{
    id: string;
    audienceIdentityId: string;
    representativeId: string;
    productCode: string;
  }> = [];
  servicePaymentOrders: Array<{ id: string; payerAudienceIdentityId: string }> = [];
  agentTokenPurchases: Array<{ id: string; audienceIdentityId: string | null }> = [];
  agentUsageCharges: Array<{ id: string; audienceIdentityId: string | null }> = [];

  $transaction = async (callback: any, _options?: unknown) => callback(this);

  audienceIdentity = {
    upsert: async (args: any) => {
      const existing = this.audienceIdentities.find(
        (identity) => identity.audienceKey === args.where.audienceKey,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const identity: AudienceIdentityRow = {
        id: `identity-${this.audienceIdentities.length + 1}`,
        audienceKey: args.create.audienceKey,
        status: args.create.status,
        mergedIntoId: null,
        lastSeenAt: args.create.lastSeenAt,
      };
      this.audienceIdentities.push(identity);
      return identity;
    },
    update: async (args: any) => {
      const identity = this.audienceIdentities.find((item) => item.id === args.where.id);
      if (!identity) {
        throw new Error("identity not found");
      }
      Object.assign(identity, args.data);
      return identity;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const identity of this.audienceIdentities) {
        if (
          identity.id === args.where.id &&
          (args.where.status === undefined || identity.status === args.where.status) &&
          (args.where.mergedIntoId === undefined ||
            identity.mergedIntoId === args.where.mergedIntoId)
        ) {
          Object.assign(identity, args.data);
          count += 1;
        }
      }
      return { count };
    },
    findUnique: async (args: any) => {
      return this.audienceIdentities.find((identity) => identity.id === args.where.id) ?? null;
    },
  };

  identityLink = {
    findUnique: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const link = this.identityLinks.find(
        (item) => item.provider === key.provider && item.providerSubject === key.providerSubject,
      );
      return link
        ? {
            id: link.id,
            audienceIdentityId: link.audienceIdentityId,
            ...(link.issuer ? { issuer: link.issuer } : {}),
            connectionId: link.connectionId,
            revokedAt: link.revokedAt ?? null,
          }
        : null;
    },
    create: async (args: any) => {
      const existing = this.identityLinks.find(
        (link) =>
          link.provider === args.data.provider &&
          link.providerSubject === args.data.providerSubject,
      );
      if (existing) {
        throw Object.assign(new Error("Unique constraint failed on identity link"), {
          code: "P2002",
        });
      }

      const link: IdentityLinkRow = {
        id: `identity-link-${this.identityLinks.length + 1}`,
        audienceIdentityId: args.data.audienceIdentityId,
        provider: args.data.provider,
        providerSubject: args.data.providerSubject,
        issuer: args.data.issuer ?? null,
        connectionId: args.data.connectionId ?? null,
        verifiedAt: args.data.verifiedAt ?? null,
        metadata: args.data.metadata ?? null,
      };
      this.identityLinks.push(link);
      return link;
    },
    upsert: async (args: any) => {
      const key = args.where.provider_providerSubject;
      const existing = this.identityLinks.find(
        (link) => link.provider === key.provider && link.providerSubject === key.providerSubject,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const link: IdentityLinkRow = {
        id: `identity-link-${this.identityLinks.length + 1}`,
        audienceIdentityId: args.create.audienceIdentityId,
        provider: args.create.provider,
        providerSubject: args.create.providerSubject,
        issuer: args.create.issuer ?? null,
        connectionId: args.create.connectionId ?? null,
        verifiedAt: args.create.verifiedAt ?? null,
        metadata: args.create.metadata ?? null,
      };
      this.identityLinks.push(link);
      return link;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const link of this.identityLinks) {
        if (
          (args.where.audienceIdentityId === undefined ||
            link.audienceIdentityId === args.where.audienceIdentityId) &&
          (args.where.provider === undefined || link.provider === args.where.provider) &&
          (args.where.providerSubject === undefined ||
            link.providerSubject === args.where.providerSubject)
        ) {
          Object.assign(link, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  identityLinkConnectionProof = {
    findUnique: async (args: any) => {
      const key = args.where.identityLinkId_issuer_connectionId;
      return this.identityLinkConnectionProofs.find(
        (proof) =>
          proof.identityLinkId === key.identityLinkId
          && proof.issuer === key.issuer
          && proof.connectionId === key.connectionId,
      ) ?? null;
    },
    upsert: async (args: any) => {
      const key = args.where.identityLinkId_issuer_connectionId;
      const existing = this.identityLinkConnectionProofs.find(
        (proof) =>
          proof.identityLinkId === key.identityLinkId
          && proof.issuer === key.issuer
          && proof.connectionId === key.connectionId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const proof: IdentityLinkConnectionProofRow = {
        identityLinkId: args.create.identityLinkId,
        issuer: args.create.issuer,
        connectionId: args.create.connectionId,
        verifiedAt: args.create.verifiedAt,
        assuranceLevel: args.create.assuranceLevel,
        revokedAt: args.create.revokedAt,
        proofMetadata: args.create.proofMetadata ?? null,
      };
      this.identityLinkConnectionProofs.push(proof);
      return proof;
    },
  };

  contact = {
    upsert: async (args: any) => {
      const key = args.where.representativeId_telegramUserId;
      const existing = this.contacts.find(
        (contact) =>
          contact.representativeId === key.representativeId &&
          contact.telegramUserId === key.telegramUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const contact: ContactRow = {
        id: `contact-${this.contacts.length + 1}`,
        representativeId: args.create.representativeId,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        telegramUserId: args.create.telegramUserId,
        channelUserId: args.create.channelUserId ?? null,
        username: args.create.username ?? null,
        displayName: args.create.displayName ?? null,
        source: args.create.source ?? null,
        sourceChannel: args.create.sourceChannel ?? null,
        lastSeenAt: args.create.lastSeenAt ?? new Date(),
      };
      this.contacts.push(contact);
      return contact;
    },
    updateMany: async (args: any) => updateAudienceIdentityRows(this.contacts, args),
  };

  conversation = {
    upsert: async (args: any) => {
      const key = args.where.representativeId_telegramChatId_contactId;
      const existing = this.conversations.find(
        (conversation) =>
          conversation.representativeId === key.representativeId &&
          conversation.telegramChatId === key.telegramChatId &&
          conversation.contactId === key.contactId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const conversation: ConversationRow = {
        id: `conversation-${this.conversations.length + 1}`,
        representativeId: args.create.representativeId,
        contactId: args.create.contactId,
        audienceIdentityId: args.create.audienceIdentityId ?? null,
        telegramChatId: args.create.telegramChatId,
        channelThreadId: args.create.channelThreadId ?? null,
        channel: args.create.channel,
        sourceChannel: args.create.sourceChannel ?? null,
        state: args.create.state ?? "ACTIVE",
        freeRepliesUsed: args.create.freeRepliesUsed ?? 0,
        lastMessageAt: args.create.lastMessageAt ?? new Date(),
      };
      this.conversations.push(conversation);
      return conversation;
    },
    updateMany: async (args: any) => updateAudienceIdentityRows(this.conversations, args),
    update: async (args: any) => {
      const conversation = this.conversations.find((item) => item.id === args.where.id);
      if (!conversation) {
        throw new Error("conversation not found");
      }
      if (args.data.freeRepliesUsed?.increment) {
        conversation.freeRepliesUsed += args.data.freeRepliesUsed.increment;
      }
      if (args.data.lastMessageAt) {
        conversation.lastMessageAt = args.data.lastMessageAt;
      }
      return conversation;
    },
  };

  userWallet = {
    count: async (args: any) =>
      this.userWallets.filter(
        (wallet) => wallet.audienceIdentityId === args.where.audienceIdentityId,
      ).length,
    updateMany: async (args: any) => updateAudienceIdentityRows(this.userWallets, args),
  };

  sandboxIdentity = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.sandboxIdentities, args),
  };

  openVikingMemoryRecord = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.memoryRecords, args),
  };

  delegationTask = {
    updateMany: async (args: any) => updateAudienceIdentityRows(this.delegationTasks, args),
  };

  serviceEntitlementAccount = {
    count: async (args: any) =>
      this.serviceEntitlementAccounts.filter(
        (account) => account.audienceIdentityId === args.where.audienceIdentityId,
      ).length,
    findMany: async (args: any) =>
      this.serviceEntitlementAccounts
        .filter((account) => account.audienceIdentityId === args.where.audienceIdentityId)
        .map((account) => ({
          id: account.id,
          representativeId: account.representativeId,
          productCode: account.productCode,
        })),
    updateMany: async (args: any) =>
      updateAudienceIdentityRows(this.serviceEntitlementAccounts, args),
  };

  servicePaymentOrder = {
    count: async (args: any) =>
      this.servicePaymentOrders.filter(
        (order) => order.payerAudienceIdentityId === args.where.payerAudienceIdentityId,
      ).length,
    updateMany: async (args: any) => {
      let count = 0;
      for (const order of this.servicePaymentOrders) {
        if (order.payerAudienceIdentityId === args.where.payerAudienceIdentityId) {
          order.payerAudienceIdentityId = args.data.payerAudienceIdentityId;
          count += 1;
        }
      }
      return { count };
    },
  };

  agentTokenPurchase = {
    count: async (args: any) =>
      this.agentTokenPurchases.filter(
        (purchase) => purchase.audienceIdentityId === args.where.audienceIdentityId,
      ).length,
    updateMany: async (args: any) => updateAudienceIdentityRows(this.agentTokenPurchases, args),
  };

  agentUsageCharge = {
    count: async (args: any) =>
      this.agentUsageCharges.filter(
        (charge) => charge.audienceIdentityId === args.where.audienceIdentityId,
      ).length,
    updateMany: async (args: any) => updateAudienceIdentityRows(this.agentUsageCharges, args),
  };

  conversationTurn = {
    create: async (args: any) => {
      const turn: TurnRow = {
        id: `turn-${this.turns.length + 1}`,
        conversationId: args.data.conversationId,
        direction: args.data.direction,
        messageText: args.data.messageText,
        intent: args.data.intent ?? null,
        summary: args.data.summary ?? null,
        createdAt: args.data.createdAt ?? new Date(),
      };
      this.turns.push(turn);
      return turn;
    },
    findMany: async (args: any) => {
      return this.turns
        .filter((turn) => turn.conversationId === args.where.conversationId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, args.take);
    },
  };
}

function updateAudienceIdentityRows<T extends { audienceIdentityId: string | null }>(
  rows: T[],
  args: any,
) {
  let count = 0;
  for (const row of rows) {
    if (row.audienceIdentityId === args.where.audienceIdentityId) {
      row.audienceIdentityId = args.data.audienceIdentityId;
      count += 1;
    }
  }
  return { count };
}

function registerIdentity(client: FakeWebAudienceClient, audienceIdentityId: string) {
  setIdentityState(client, audienceIdentityId, "REGISTERED", null);
}

function setIdentityState(
  client: FakeWebAudienceClient,
  audienceIdentityId: string,
  status: AudienceIdentityRow["status"],
  mergedIntoId: string | null,
) {
  const identity = client.audienceIdentities.find((item) => item.id === audienceIdentityId);
  if (!identity) {
    throw new Error(`identity ${audienceIdentityId} not found`);
  }
  identity.status = status;
  identity.mergedIntoId = mergedIntoId;
}

function buildContactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "contact-1",
    representativeId: "rep-1",
    audienceIdentityId: "identity-1",
    telegramUserId: "web:aud_123",
    channelUserId: "web:aud_123",
    username: null,
    displayName: "Web visitor",
    source: "web",
    sourceChannel: "web",
    lastSeenAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildConversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conversation-1",
    representativeId: "rep-1",
    contactId: "contact-1",
    audienceIdentityId: "identity-1",
    telegramChatId: "web:aud_123",
    channelThreadId: "web:aud_123",
    channel: "PRIVATE_CHAT",
    sourceChannel: "web",
    state: "ACTIVE",
    freeRepliesUsed: 0,
    lastMessageAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}
