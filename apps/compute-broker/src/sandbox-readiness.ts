import { computeBrokerConfig } from "./config";
import { prisma } from "./prisma";
import { createConfiguredProviderRegistry } from "./sandbox-leases";
import {
  validateSandboxRoutingRepresentatives,
  type SandboxProviderKind,
} from "./sandbox-routing";

const LOCAL_READINESS_TTL_MS = 90_000;

export type SandboxReadinessSnapshot = {
  status: "ready" | "degraded";
  checkedAt: string;
  routingMode: "legacy" | "manual_poc";
  configuredProviders: SandboxProviderKind[];
  pinnedProviders: SandboxProviderKind[];
  reasons: string[];
};

let cached: { expiresAt: number; value: SandboxReadinessSnapshot } | null = null;
let inflight: Promise<SandboxReadinessSnapshot> | null = null;

export function getSandboxReadinessSnapshot(options: { force?: boolean } = {}) {
  const now = Date.now();
  if (!options.force && cached && cached.expiresAt > now) return Promise.resolve(cached.value);
  if (!options.force && inflight) return inflight;
  inflight = loadSandboxReadinessSnapshot()
    .then((value) => {
      cached = { expiresAt: Date.now() + LOCAL_READINESS_TTL_MS, value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearSandboxReadinessCache() {
  cached = null;
  inflight = null;
}

async function loadSandboxReadinessSnapshot(): Promise<SandboxReadinessSnapshot> {
  const registry = createConfiguredProviderRegistry();
  const providerRows = await prisma.sandboxIdentity.groupBy({
    by: ["provider"],
    where: { status: "ACTIVE" },
  });
  const pinnedProviders = providerRows.map((row) => row.provider.toLowerCase() as SandboxProviderKind);
  const reasons: string[] = [];

  for (const provider of pinnedProviders) {
    if (!registry.configured(provider)) reasons.push(`pinned_provider_unavailable:${provider}`);
  }

  const routing = computeBrokerConfig.sandboxRouting;
  if (computeBrokerConfig.sandboxRoutingMode === "manual_poc") {
    if (!routing) {
      reasons.push("sandbox_routing_document_required");
    } else {
      const representativeIds = [...routing.allowedRepresentativeIds];
      const representatives = await prisma.representative.findMany({
        where: { id: { in: representativeIds } },
        select: { id: true, sandboxTestEligible: true, lifecycleState: true },
      });
      try {
        validateSandboxRoutingRepresentatives(
          routing,
          representatives.map((representative) => ({
            id: representative.id,
            sandboxTestEligible: representative.sandboxTestEligible,
            active: representative.lifecycleState !== "ARCHIVED",
          })),
        );
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : "sandbox_routing_representative_invalid");
      }

      for (const provider of ["docker", "daytona", "tencent"] as const) {
        if (routing.document.newIdentityEnabled[provider] && !registry.configured(provider)) {
          reasons.push(`new_identity_provider_unavailable:${provider}`);
        }
      }
    }
  }

  const configuredProviders = (["docker", "daytona", "tencent"] as const)
    .filter((provider) => registry.configured(provider));
  return {
    status: reasons.length ? "degraded" : "ready",
    checkedAt: new Date().toISOString(),
    routingMode: computeBrokerConfig.sandboxRoutingMode,
    configuredProviders,
    pinnedProviders: [...new Set(pinnedProviders)],
    reasons,
  };
}
