import { builtinSkillCatalog } from "@delegate/domain";
import {
  SkillPackSource,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillSignatureStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

type BuiltinSkillReleaseInput = {
  version: string;
  executesCode: boolean;
  instructions?: string;
  instructionsSha256?: string;
  resources?: readonly string[];
};

type WorkspaceSkillReleaseWriter = {
  workspaceSkillRelease: Pick<PrismaClient["workspaceSkillRelease"], "updateMany">;
};

export function buildBuiltinWorkspaceSkillReleaseData(
  input: BuiltinSkillReleaseInput,
) {
  const registryTrustEvidence: Prisma.InputJsonObject = {
    source: "delegate_builtin",
    version: input.version,
    ...(input.instructionsSha256
      ? { instructionsSha256: input.instructionsSha256 }
      : {}),
  };

  return {
    provenanceDigest: input.instructionsSha256 ?? null,
    signatureStatus: WorkspaceSkillSignatureStatus.VERIFIED,
    registryTrustSource: "delegate_builtin",
    registryVerified: true,
    registryTrustEligible: true,
    registryTrustEvidence,
    ...(input.executesCode
      ? {
          runtimeRequirements: {
            requiredBins: ["python"],
            requiredEnv: [],
            optionalEnv: [],
            networkMode: "no_network",
          } satisfies Prisma.InputJsonObject,
        }
      : {}),
    instructions: input.instructions ?? null,
    instructionsSha256: input.instructionsSha256 ?? null,
    resources: [...(input.resources ?? [])],
  };
}

export async function reconcileBuiltinWorkspaceSkillReleases(
  client: WorkspaceSkillReleaseWriter,
) {
  let updated = 0;

  for (const builtin of builtinSkillCatalog) {
    const result = await client.workspaceSkillRelease.updateMany({
      where: {
        status: WorkspaceSkillReleaseStatus.INSTALLED,
        version: builtin.version,
        install: {
          skillPack: {
            source: SkillPackSource.BUILTIN,
            slug: builtin.slug,
          },
        },
        OR: [
          { registryTrustEligible: false },
          { registryVerified: false },
          { signatureStatus: { not: WorkspaceSkillSignatureStatus.VERIFIED } },
          { registryTrustSource: null },
          { registryTrustSource: { not: "delegate_builtin" } },
          { provenanceDigest: { not: builtin.instructionsSha256 } },
          { instructionsSha256: { not: builtin.instructionsSha256 } },
        ],
      },
      data: buildBuiltinWorkspaceSkillReleaseData(builtin),
    });
    updated += result.count;
  }

  return { catalogSize: builtinSkillCatalog.length, updated };
}
