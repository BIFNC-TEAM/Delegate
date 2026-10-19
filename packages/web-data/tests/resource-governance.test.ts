import { describe, expect, it } from "vitest";

import { buildRepresentativeResourceGovernanceSnapshot } from "../src/resource-governance";

function createSource() {
  return {
    representative: {
      slug: "lin-founder-rep",
      displayName: "Lin Founder Rep",
    },
    ownerManagedOverlays: {
      baseline: {
        enabled: true,
        browserDecision: "ask" as const,
        browserRequiresApproval: true,
        mcpDecision: "ask" as const,
        mcpRequiresApproval: true,
      },
      trustedCustomer: {
        enabled: true,
        trustTier: "verified" as const,
        browserDecision: "allow" as const,
        browserRequiresApproval: false,
        mcpDecision: "allow" as const,
        mcpRequiresApproval: false,
      },
    },
    governance: {
      organization: {
        id: "org_lin",
        slug: "lin-ops-org",
        displayName: "Lin Ops Org",
      },
      organizationBaseline: {
        enabled: true,
        browserDecision: "ask" as const,
        browserRequiresApproval: true,
        mcpDecision: "ask" as const,
        mcpRequiresApproval: true,
      },
      customerAccounts: [
        {
          id: "acct_acme",
          slug: "acme-design-partner",
          displayName: "Acme Design Partner",
          enabled: true,
          browserDecision: "allow" as const,
          browserRequiresApproval: false,
          mcpDecision: "allow" as const,
          mcpRequiresApproval: false,
          contactIds: ["contact_acme"],
        },
      ],
      contactAssignments: [
        {
          contactId: "contact_acme",
          customerAccountId: "acct_acme",
          customerAccountSlug: "acme-design-partner",
          displayName: "Acme Buyer",
          username: "acmebuyer",
          computeTrustTier: "verified",
        },
      ],
    },
    artifacts: [
      {
        id: "artifact_acme",
        kind: "screenshot" as const,
        isPinned: true,
        contactId: "contact_acme",
        dependentDeliverableIds: ["deliverable_package"],
        dependentDeliverableTitles: ["Acme package"],
      },
      {
        id: "artifact_unassigned",
        kind: "json" as const,
        isPinned: false,
        contactId: null,
        dependentDeliverableIds: [],
        dependentDeliverableTitles: [],
      },
    ],
    deliverables: [
      {
        id: "deliverable_package",
        title: "Acme package",
        kind: "package" as const,
        visibility: "public_material" as const,
        sourceKind: "bundle" as const,
        artifactId: null,
        bundleItemArtifactIds: ["artifact_acme"],
        hasCachedPackage: true,
        createdBy: "owner-dashboard",
      },
      {
        id: "deliverable_owner_only",
        title: "Internal memo",
        kind: "generated_document" as const,
        visibility: "owner_only" as const,
        sourceKind: "artifact" as const,
        artifactId: "artifact_unassigned",
        bundleItemArtifactIds: [],
        hasCachedPackage: false,
        createdBy: "owner-dashboard",
      },
    ],
  };
}

describe("buildRepresentativeResourceGovernanceSnapshot", () => {
  it("expresses org/customer overlays on artifact and deliverable governance state", () => {
    const snapshot = buildRepresentativeResourceGovernanceSnapshot(createSource());

    expect(snapshot.summary.orgOrCustomerGovernedArtifacts).toBe(2);
    expect(snapshot.summary.orgOrCustomerGovernedDeliverables).toBe(2);
    expect(snapshot.artifacts.find((artifact) => artifact.id === "artifact_acme")).toMatchObject({
      primaryLayer: "customer_account",
      layers: expect.arrayContaining(["owner_managed", "org_managed", "customer_account", "delegate_managed"]),
      blockedUnpinByDeliverable: true,
    });
    expect(snapshot.deliverables.find((deliverable) => deliverable.id === "deliverable_package")).toMatchObject({
      primaryLayer: "customer_account",
      customerDownloadEligible: true,
      packageDeliveryEligible: true,
    });
  });

  it("places unassigned resources into the explicit default governance bucket", () => {
    const snapshot = buildRepresentativeResourceGovernanceSnapshot(createSource());

    expect(snapshot.byCustomerAccount.find((row) => row.key === "unassigned")).toMatchObject({
      isUnassigned: true,
      deliverableCount: 1,
      visibleArtifactCount: 1,
    });
    expect(snapshot.artifacts.find((artifact) => artifact.id === "artifact_unassigned")).toMatchObject({
      primaryLayer: "org_managed",
      layers: expect.arrayContaining(["unassigned_default"]),
    });
  });

  it("does not let customer-linked governance silently flip owner-only deliverables to public", () => {
    const snapshot = buildRepresentativeResourceGovernanceSnapshot(createSource());

    const ownerOnly = snapshot.deliverables.find((deliverable) => deliverable.id === "deliverable_owner_only");
    expect(ownerOnly).toMatchObject({
      visibility: "owner_only",
      customerDownloadEligible: false,
      packageDeliveryEligible: false,
    });
  });

  it("returns a stable structure when governance is empty", () => {
    const snapshot = buildRepresentativeResourceGovernanceSnapshot({
      representative: {
        slug: "lin-founder-rep",
        displayName: "Lin Founder Rep",
      },
      ownerManagedOverlays: {
        baseline: {
          enabled: true,
          browserDecision: "ask",
          browserRequiresApproval: true,
          mcpDecision: "ask",
          mcpRequiresApproval: true,
        },
        trustedCustomer: {
          enabled: true,
          trustTier: "verified",
          browserDecision: "ask",
          browserRequiresApproval: true,
          mcpDecision: "allow",
          mcpRequiresApproval: false,
        },
      },
      governance: {
        organization: {
          id: null,
          slug: null,
          displayName: null,
        },
        organizationBaseline: {
          enabled: true,
          browserDecision: "ask",
          browserRequiresApproval: true,
          mcpDecision: "ask",
          mcpRequiresApproval: true,
        },
        customerAccounts: [],
        contactAssignments: [],
      },
      artifacts: [],
      deliverables: [],
    });

    expect(snapshot.summary).toEqual({
      artifactCount: 0,
      pinnedArtifacts: 0,
      orgOrCustomerGovernedArtifacts: 0,
      artifactOwnerOnlyActionCount: 0,
      deliverableCount: 0,
      publicMaterials: 0,
      ownerOnlyDeliverables: 0,
      cachedPackages: 0,
      orgOrCustomerGovernedDeliverables: 0,
      deliverableOwnerOnlyActionCount: 0,
    });
    expect(snapshot.byCustomerAccount).toEqual([]);
    expect(snapshot.riskyActions.blockedArtifactUnpins).toEqual([]);
    expect(snapshot.hygiene.items).toEqual([]);
  });
});
