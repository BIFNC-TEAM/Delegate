import { Prisma, PrismaClient } from "@prisma/client";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL?.trim();
if (!databaseUrl || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)) {
  throw new Error("AGENT_TEST_DATABASE_URL must target the isolated 127.0.0.1:15432 Delegate database.");
}

const action = process.argv[2];
if (action !== "activate" && action !== "restore") {
  throw new Error("Usage: agent-test-tencent-version.ts <activate|restore> [originalVersionId]");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  const representative = await prisma.representative.findUnique({
    where: { slug: "lin-founder-rep" },
    include: { activeVersion: true },
  });
  if (!representative?.activeVersion) throw new Error("Isolated test representative/version is missing.");

  if (action === "restore") {
    const originalVersionId = process.argv[3]?.trim();
    if (!originalVersionId) throw new Error("The original version id is required for restore.");
    const original = await prisma.representativeVersion.findFirst({
      where: { id: originalVersionId, representativeId: representative.id, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!original) throw new Error("The requested original test version is unavailable.");
    await prisma.representative.update({
      where: { id: representative.id },
      data: { activeVersionId: original.id },
    });
    process.stdout.write(`${JSON.stringify({ action, activeVersionId: original.id })}\n`);
    return;
  }

  const originalVersionId = representative.activeVersion.id;
  const snapshot = structuredClone(representative.activeVersion.snapshot) as Prisma.JsonObject;
  const compute = snapshot.compute;
  if (!compute || typeof compute !== "object" || Array.isArray(compute)) {
    throw new Error("Published test version has no compute snapshot.");
  }
  snapshot.compute = {
    ...(compute as Prisma.JsonObject),
    networkMode: "no_network",
    networkAllowlist: [],
  };
  const existing = await prisma.representativeVersion.findFirst({
    where: {
      representativeId: representative.id,
      changeSummary: "Agent test Tencent NO_NETWORK product E2E",
    },
    orderBy: { versionNumber: "desc" },
  });
  const version = existing ?? await prisma.representativeVersion.create({
    data: {
      id: `agent_test_representative_version_tencent_${Date.now()}`,
      representativeId: representative.id,
      versionNumber: (await prisma.representativeVersion.aggregate({
        where: { representativeId: representative.id },
        _max: { versionNumber: true },
      }))._max.versionNumber! + 1,
      status: "PUBLISHED",
      snapshot,
      changeSummary: "Agent test Tencent NO_NETWORK product E2E",
      publishedBy: representative.ownerId,
    },
  });
  await prisma.representative.update({
    where: { id: representative.id },
    data: { activeVersionId: version.id },
  });
  process.stdout.write(`${JSON.stringify({ action, originalVersionId, activeVersionId: version.id })}\n`);
}

main().finally(() => prisma.$disconnect());
