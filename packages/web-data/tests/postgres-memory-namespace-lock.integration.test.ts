import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../src/prisma";

const describePostgres = process.env.DELEGATE_POSTGRES_E2E === "1"
  ? describe
  : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("Memory System namespace-key lock", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects namespace changes while allowing ordinary policy updates", async () => {
    const suffix = crypto.randomUUID();
    const owner = await prisma.owner.create({
      data: { displayName: `Memory namespace lock ${suffix}` },
    });

    try {
      const representative = await prisma.representative.create({
        data: {
          ownerId: owner.id,
          slug: `memory-namespace-lock-${suffix}`,
          displayName: "Memory namespace lock representative",
          roleSummary: "Exercises the server-managed memory namespace lock.",
          tone: "clear",
          languages: ["en"],
          freeScope: [],
          paywalledIntents: [],
          handoffPrompt: "Escalate.",
          allowedSkills: [],
          actionGate: {},
        },
      });
      const namespaceKey = `namespace_${suffix}`;
      await prisma.representativeMemoryPolicy.create({
        data: {
          representativeId: representative.id,
          namespaceKey,
        },
      });

      const updated = await prisma.representativeMemoryPolicy.update({
        where: { representativeId: representative.id },
        data: { recallLimit: 7 },
      });
      expect(updated).toMatchObject({ namespaceKey, recallLimit: 7 });

      await expect(prisma.representativeMemoryPolicy.update({
        where: { representativeId: representative.id },
        data: { namespaceKey: `replacement_${suffix}` },
      })).rejects.toThrow();

      await expect(prisma.representativeMemoryPolicy.findUniqueOrThrow({
        where: { representativeId: representative.id },
        select: { namespaceKey: true, recallLimit: true },
      })).resolves.toEqual({ namespaceKey, recallLimit: 7 });
    } finally {
      await prisma.representative.deleteMany({ where: { ownerId: owner.id } });
      await prisma.owner.delete({ where: { id: owner.id } });
    }
  });
});

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the Memory System PostgreSQL E2E.");
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1"].includes(host)
    || !["test", "e2e", "delegate"].some((marker) => database.includes(marker))
  ) {
    throw new Error(`Refusing Memory System PostgreSQL E2E against ${host}/${database}.`);
  }
}
