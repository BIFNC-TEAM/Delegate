import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describePostgres =
  process.env.DELEGATE_SEED_POSTGRES_E2E === "1"
    ? describe
    : describe.skip;

if (process.env.DELEGATE_SEED_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

const prisma = new PrismaClient();
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const representativeId = "rep_lin_founder";
const representativeSlug = "lin-founder-rep";

describePostgres("fresh PostgreSQL seed", () => {
  beforeAll(async () => {
    const [version] = await prisma.$queryRaw<
      Array<{ server_version_num: string }>
    >`SELECT current_setting('server_version_num') AS server_version_num`;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Fresh seed E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }

    expect(
      await prisma.representative.count({
        where: { slug: representativeSlug },
      }),
    ).toBe(0);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates the demo workspace once and skips without changing it on a second run", async () => {
    const firstRun = runSeedCommand();
    expect(firstRun).toContain(`Seeded representative ${representativeSlug}.`);

    const seeded = await readSeedSnapshot();
    expect(seeded.representative).toMatchObject({
      id: representativeId,
      slug: representativeSlug,
      freeScope: [],
      paywalledIntents: [],
      actionGate: {},
      owner: {
        displayName: "Lin",
        identityLinks: [
          {
            email: "creator@delegate.local",
            issuer: "https://local-auth.delegate.invalid/oidc",
            providerSubject: "delegate-dev-owner",
            verifiedAt: expect.any(Date),
          },
        ],
      },
    });
    expect(seeded.skillInstallCount).toBeGreaterThan(0);
    expect(seeded.skillReleaseCount).toBeGreaterThan(0);

    await prisma.ownerIdentityLink.updateMany({
      where: {
        ownerId: "owner_lin_demo",
        provider: "LOGTO",
        providerSubject: "delegate-dev-owner",
      },
      data: {
        issuer: null,
        metadata: {
          mode: "development",
          actor: "owner",
          fixture: "prisma-seed",
        },
      },
    });
    const secondRun = runSeedCommand();
    expect(secondRun).toContain(
      `Seed skipped: representative "${representativeSlug}" already exists.`,
    );
    await expect(readSeedSnapshot()).resolves.toEqual(seeded);
  });
});

async function readSeedSnapshot() {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      freeScope: true,
      paywalledIntents: true,
      actionGate: true,
      owner: {
        select: {
          displayName: true,
          identityLinks: {
            where: {
              provider: "LOGTO",
              providerSubject: "delegate-dev-owner",
            },
            select: {
              email: true,
              issuer: true,
              providerSubject: true,
              verifiedAt: true,
            },
          },
        },
      },
    },
  });

  const [skillInstallCount, skillReleaseCount] = await Promise.all([
    prisma.workspaceSkillInstall.count({
      where: {
        representativeBindings: {
          some: { representativeId },
        },
      },
    }),
    prisma.workspaceSkillRelease.count({
      where: {
        install: {
          representativeBindings: {
            some: { representativeId },
          },
        },
      },
    }),
  ]);

  return {
    representative,
    skillInstallCount,
    skillReleaseCount,
  };
}

function runSeedCommand() {
  return execFileSync("pnpm", ["--dir", repoRoot, "run", "db:seed"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for the fresh seed PostgreSQL E2E.");
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote seed E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
