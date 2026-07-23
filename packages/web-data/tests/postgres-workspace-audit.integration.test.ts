import { EventType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getWorkspaceAuditExport,
  getWorkspaceAuditSnapshot,
} from "../src/workspace-audit";
import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("workspace audit PostgreSQL queries", () => {
  it("keeps anomaly counts, whitelisted search, owner scope, and keyset pages correct", async () => {
    const fixture = await createAuditFixture();
    try {
      const first = await getWorkspaceAuditSnapshot({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        category: "all",
        query: "needle",
        limit: 2,
      });

      expect(first?.metrics).toMatchObject({
        total: 3,
        anomalies: 1,
      });
      expect(first?.page).toMatchObject({
        filteredTotal: 3,
        hasMore: true,
      });
      expect(first?.events).toHaveLength(2);
      expect(first?.page.nextCursor).toBeTruthy();
      const nextCursor = first?.page.nextCursor;
      if (!nextCursor) throw new Error("Expected a second audit page.");

      const second = await getWorkspaceAuditSnapshot({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        category: "all",
        query: "needle",
        limit: 2,
        cursor: nextCursor,
      });
      expect(second?.events).toHaveLength(1);
      expect(second?.page.hasMore).toBe(false);
      expect(new Set([
        ...(first?.events.map((event) => event.id) ?? []),
        ...(second?.events.map((event) => event.id) ?? []),
      ]).size).toBe(3);

      const hiddenPayloadSearch = await getWorkspaceAuditSnapshot({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        category: "all",
        query: "credential-only-secret",
      });
      expect(hiddenPayloadSearch?.page.filteredTotal).toBe(0);

      const emptyCategorySearch = await getWorkspaceAuditSnapshot({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        category: "security",
        query: "needle",
      });
      expect(emptyCategorySearch?.page.filteredTotal).toBe(0);
      expect(emptyCategorySearch?.events).toEqual([]);

      const auditExport = await getWorkspaceAuditExport({
        ownerId: fixture.ownerId,
        activeRepresentativeSlug: fixture.representativeSlug,
        category: "all",
        query: "needle",
      });
      const exportedIds: string[] = [];
      for await (const event of auditExport?.events ?? []) {
        exportedIds.push(event.id);
      }
      expect(auditExport?.filteredTotal).toBe(3);
      expect(new Set(exportedIds)).toEqual(new Set(fixture.ownerEventIds));
    } finally {
      await deleteAuditFixture(fixture);
    }
  });
});

async function createAuditFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const owner = await prisma.owner.create({
    data: { displayName: `Audit owner ${suffix}` },
    select: { id: true },
  });
  const foreignOwner = await prisma.owner.create({
    data: { displayName: `Foreign audit owner ${suffix}` },
    select: { id: true },
  });
  const createRepresentative = (ownerId: string, slugPrefix: string) =>
    prisma.representative.create({
      data: {
        ownerId,
        slug: `${slugPrefix}-${suffix}`,
        displayName: `${slugPrefix} audit representative`,
        roleSummary: "Audit integration test",
        tone: "concise",
        languages: ["en"],
        freeScope: [],
        paywalledIntents: [],
        handoffPrompt: "Handoff",
        allowedSkills: [],
        actionGate: {},
      },
      select: { id: true, slug: true },
    });
  const representative = await createRepresentative(owner.id, "audit-e2e");
  const foreignRepresentative = await createRepresentative(
    foreignOwner.id,
    "audit-e2e-foreign",
  );
  const createdAt = new Date("2026-07-23T12:34:56.789Z");
  const ownerEventIds = [
    `audit-e2e-${suffix}-a`,
    `audit-e2e-${suffix}-b`,
    `audit-e2e-${suffix}-c`,
  ] as const;
  const foreignEventId = `audit-e2e-${suffix}-foreign`;

  await prisma.eventAudit.createMany({
    data: [
      {
        id: ownerEventIds[0],
        representativeId: representative.id,
        type: EventType.SKILL_INSTALLED,
        payload: {
          skillSlug: "needle-skill",
          credential: "credential-only-secret",
        },
        createdAt,
      },
      {
        id: ownerEventIds[1],
        representativeId: representative.id,
        type: EventType.WORKFLOW_COMPLETED,
        payload: { actorId: "Needle Actor" },
        createdAt,
      },
      {
        id: ownerEventIds[2],
        representativeId: representative.id,
        type: EventType.MESSAGE_ANSWERED,
        payload: { requestId: "needle-request", status: "FaIlEd" },
        createdAt,
      },
      {
        id: foreignEventId,
        representativeId: foreignRepresentative.id,
        type: EventType.SKILL_INSTALLED,
        payload: { skillSlug: "needle-foreign" },
        createdAt,
      },
    ],
  });

  return {
    ownerId: owner.id,
    foreignOwnerId: foreignOwner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    foreignRepresentativeId: foreignRepresentative.id,
    ownerEventIds,
    foreignEventId,
  };
}

async function deleteAuditFixture(fixture: Awaited<ReturnType<typeof createAuditFixture>>) {
  await prisma.eventAudit.deleteMany({
    where: {
      id: { in: [...fixture.ownerEventIds, fixture.foreignEventId] },
    },
  });
  await prisma.representative.deleteMany({
    where: {
      id: {
        in: [fixture.representativeId, fixture.foreignRepresentativeId],
      },
    },
  });
  await prisma.owner.deleteMany({
    where: {
      id: { in: [fixture.ownerId, fixture.foreignOwnerId] },
    },
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the workspace audit PostgreSQL E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
