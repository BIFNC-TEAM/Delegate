import { prisma } from "./prisma";
import { generalCodeExecutionAvailability } from "@delegate/compute-protocol";
import { getRepresentativeRuntimeAuthoritySnapshot, type RepresentativeSetupSnapshot } from "./representative-setup";

export type RepresentativeComputePolicyView = {
  asOf: string;
  state: "ready" | "unpublished" | "unavailable";
  publishedVersion: { id: string; number: number; publishedAt: string } | null;
  /** Published ceiling intersected with live restrictions; not a per-action decision. */
  runtimeCeiling: RepresentativeSetupSnapshot["compute"] | null;
  codeExecution?: { available: boolean; profileId: string | null; reason: string };
};

/** Owner-facing explanation only. Execution still revalidates each request. */
export async function getRepresentativeComputePolicyView(slug: string): Promise<RepresentativeComputePolicyView | null> {
  const asOf = new Date().toISOString();
  if (!process.env.DATABASE_URL?.trim()) return { asOf, state: "unavailable", publishedVersion: null, runtimeCeiling: null };
  const representative = await prisma.representative.findUnique({
    where: { slug }, select: { id: true, activeVersion: { select: { id: true, versionNumber: true, publishedAt: true } } },
  });
  if (!representative) return null;
  const version = representative.activeVersion;
  if (!version) return { asOf, state: "unpublished", publishedVersion: null, runtimeCeiling: null };
  // Pin this read to the observed version; use the SAME resolver as execution,
  // not a parallel implementation of allow/ask/deny precedence in the UI.
  const authority = await getRepresentativeRuntimeAuthoritySnapshot(slug, version.id);
  return {
    asOf, state: authority ? "ready" : "unavailable",
    publishedVersion: { id: version.id, number: version.versionNumber, publishedAt: version.publishedAt.toISOString() },
    runtimeCeiling: authority?.compute ?? null,
    codeExecution: generalCodeExecutionAvailability,
  };
}
