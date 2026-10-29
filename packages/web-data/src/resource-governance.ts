type GovernanceLayer =
  | "delegate_managed"
  | "owner_managed"
  | "org_managed"
  | "customer_account"
  | "unassigned_default";

type ArtifactKind = "stdout" | "stderr" | "file" | "archive" | "screenshot" | "json" | "trace";
type DeliverableKind = "deck" | "case_study" | "download" | "generated_document" | "package";
type DeliverableVisibility = "owner_only" | "public_material";
type DeliverableSourceKind = "artifact" | "external_link" | "bundle";
type PolicyDecision = "allow" | "ask" | "deny";

type OverlayConfig = {
  enabled: boolean;
  browserDecision: PolicyDecision;
  browserRequiresApproval: boolean;
  mcpDecision: PolicyDecision;
  mcpRequiresApproval: boolean;
};

type GovernanceContactAssignment = {
  contactId: string;
  displayName?: string | null;
  username?: string | null;
  computeTrustTier?: string | null;
  customerAccountId?: string | null;
  customerAccountSlug?: string | null;
};

type GovernanceCustomerAccount = OverlayConfig & {
  id?: string | null;
  slug: string;
  displayName: string;
  contactIds: string[];
};

export type ResourceGovernanceSource = {
  representative: {
    slug: string;
    displayName: string;
  };
  ownerManagedOverlays: {
    baseline: OverlayConfig;
    trustedCustomer: OverlayConfig & {
      trustTier: "standard" | "verified" | "vip" | "restricted";
    };
  };
  governance: {
    organization: {
      id?: string | null;
      slug?: string | null;
      displayName?: string | null;
    };
    organizationBaseline: OverlayConfig;
    customerAccounts: GovernanceCustomerAccount[];
    contactAssignments: GovernanceContactAssignment[];
  };
  artifacts: Array<{
    id: string;
    kind: ArtifactKind;
    isPinned: boolean;
    contactId?: string | null;
    dependentDeliverableIds: string[];
    dependentDeliverableTitles: string[];
  }>;
  deliverables: Array<{
    id: string;
    title: string;
    kind: DeliverableKind;
    visibility: DeliverableVisibility;
    sourceKind: DeliverableSourceKind;
    artifactId?: string | null;
    bundleItemArtifactIds: string[];
    hasCachedPackage: boolean;
    createdBy?: string | null;
  }>;
};

export type RepresentativeResourceGovernanceSnapshot = {
  representative: {
    slug: string;
    displayName: string;
  };
  summary: {
    artifactCount: number;
    pinnedArtifacts: number;
    orgOrCustomerGovernedArtifacts: number;
    artifactOwnerOnlyActionCount: number;
    deliverableCount: number;
    publicMaterials: number;
    ownerOnlyDeliverables: number;
    cachedPackages: number;
    orgOrCustomerGovernedDeliverables: number;
    deliverableOwnerOnlyActionCount: number;
  };
  byGovernanceLayer: Array<{
    key: GovernanceLayer;
    label: string;
    artifactCount: number;
    deliverableCount: number;
    resourceCount: number;
  }>;
  byCustomerAccount: Array<{
    key: string;
    slug: string;
    displayName: string;
    isUnassigned: boolean;
    visibleArtifactCount: number;
    deliverableCount: number;
    publicMaterialCount: number;
    restrictedActionCount: number;
  }>;
  riskyActions: {
    packageRebuildsRequireOwner: Array<{
      id: string;
      title: string;
      layer: GovernanceLayer;
    }>;
    publicMaterialFlipsRequireOwner: Array<{
      id: string;
      title: string;
      layer: GovernanceLayer;
    }>;
    blockedArtifactUnpins: Array<{
      artifactId: string;
      deliverableTitles: string[];
      layer: GovernanceLayer;
    }>;
  };
  hygiene: {
    missingCustomerContextCount: number;
    ambiguousGovernanceCount: number;
    publicDeliverablesWithoutAttributionCount: number;
    items: Array<{
      key: string;
      label: string;
      detail: string;
      count: number;
    }>;
  };
  artifacts: Array<{
    id: string;
    kind: ArtifactKind;
    customerAccount: {
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
    };
    primaryLayer: GovernanceLayer;
    layers: GovernanceLayer[];
    ownerOnlyActions: string[];
    restrictedActions: string[];
    blockedUnpinByDeliverable: boolean;
    dependentDeliverableCount: number;
  }>;
  deliverables: Array<{
    id: string;
    title: string;
    kind: DeliverableKind;
    visibility: DeliverableVisibility;
    sourceKind: DeliverableSourceKind;
    customerAccounts: Array<{
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
    }>;
    primaryLayer: GovernanceLayer;
    layers: GovernanceLayer[];
    ownerOnlyActions: string[];
    restrictedActions: string[];
    customerDownloadEligible: boolean;
    packageDeliveryEligible: boolean;
    ambiguousCustomerContext: boolean;
    hasCachedPackage: boolean;
  }>;
};

const governanceLayerOrder: GovernanceLayer[] = [
  "delegate_managed",
  "owner_managed",
  "org_managed",
  "customer_account",
  "unassigned_default",
];

const governanceLayerLabels: Record<GovernanceLayer, string> = {
  delegate_managed: "Delegate managed",
  owner_managed: "Owner managed",
  org_managed: "Org managed",
  customer_account: "Customer account",
  unassigned_default: "Unassigned / default",
};

export function buildRepresentativeResourceGovernanceSnapshot(
  source: ResourceGovernanceSource,
): RepresentativeResourceGovernanceSnapshot {
  const contactAssignments = new Map(
    source.governance.contactAssignments.map((assignment) => [assignment.contactId, assignment] as const),
  );
  const customerAccounts = new Map(
    source.governance.customerAccounts.map((account) => [account.id ?? account.slug, account] as const),
  );

  const artifacts = source.artifacts.map((artifact) => {
    const customerAccount = resolveArtifactCustomerAccount(artifact.contactId ?? null, contactAssignments, customerAccounts);
    const layers = resolveResourceLayers({
      hasCustomerAccount: !customerAccount.isUnassigned,
      hasOrganization: Boolean(source.governance.organization.id),
      isPublicMaterial: false,
      hasBundleSafety: artifact.dependentDeliverableIds.length > 0,
    });
    return {
      id: artifact.id,
      kind: artifact.kind,
      customerAccount,
      primaryLayer: resolvePrimaryLayer(layers),
      layers,
      ownerOnlyActions: ["pin", "unpin", "read", "download"],
      restrictedActions: artifact.dependentDeliverableIds.length
        ? ["unpin_blocked_by_deliverable_dependency"]
        : [],
      blockedUnpinByDeliverable: artifact.dependentDeliverableIds.length > 0,
      dependentDeliverableCount: artifact.dependentDeliverableIds.length,
    };
  });

  const artifactAccountLookup = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.customerAccount] as const),
  );

  const deliverables = source.deliverables.map((deliverable) => {
    const customerRefs = resolveDeliverableCustomerAccounts(deliverable, artifactAccountLookup);
    const ambiguousCustomerContext = new Set(customerRefs.map((customer) => customer.key)).size > 1;
    const chosenCustomer = customerRefs[0] ?? createUnassignedCustomerRef();
    const layers = resolveResourceLayers({
      hasCustomerAccount: !chosenCustomer.isUnassigned,
      hasOrganization: Boolean(source.governance.organization.id),
      isPublicMaterial: deliverable.visibility === "public_material",
      hasBundleSafety: deliverable.sourceKind === "bundle" || deliverable.hasCachedPackage,
    });

    return {
      id: deliverable.id,
      title: deliverable.title,
      kind: deliverable.kind,
      visibility: deliverable.visibility,
      sourceKind: deliverable.sourceKind,
      customerAccounts: customerRefs.length ? customerRefs : [createUnassignedCustomerRef()],
      primaryLayer: resolvePrimaryLayer(layers),
      layers,
      ownerOnlyActions: ["create", "update", "manage_owner_only", "publish_public_material"].concat(
        deliverable.sourceKind === "bundle" ? ["package_rebuild"] : [],
      ),
      restrictedActions: ambiguousCustomerContext ? ["ambiguous_customer_context"] : [],
      customerDownloadEligible:
        deliverable.visibility === "public_material" &&
        customerRefs.length === 1 &&
        !customerRefs[0]!.isUnassigned,
      packageDeliveryEligible:
        deliverable.sourceKind === "bundle" &&
        deliverable.visibility === "public_material" &&
        customerRefs.length === 1 &&
        !customerRefs[0]!.isUnassigned,
      ambiguousCustomerContext,
      hasCachedPackage: deliverable.hasCachedPackage,
    };
  });

  const byGovernanceLayer = governanceLayerOrder.map((layer) => {
    const artifactCount = artifacts.filter((artifact) => artifact.layers.includes(layer)).length;
    const deliverableCount = deliverables.filter((deliverable) => deliverable.layers.includes(layer)).length;
    return {
      key: layer,
      label: governanceLayerLabels[layer],
      artifactCount,
      deliverableCount,
      resourceCount: artifactCount + deliverableCount,
    };
  });

  const customerBuckets = buildCustomerBuckets(artifacts, deliverables);
  const riskyActions = {
    packageRebuildsRequireOwner: deliverables
      .filter((deliverable) => deliverable.sourceKind === "bundle")
      .map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        layer: deliverable.primaryLayer,
      })),
    publicMaterialFlipsRequireOwner: deliverables
      .filter((deliverable) => deliverable.visibility === "public_material")
      .map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        layer: deliverable.primaryLayer,
      })),
    blockedArtifactUnpins: artifacts
      .filter((artifact) => artifact.blockedUnpinByDeliverable)
      .map((artifact) => ({
        artifactId: artifact.id,
        deliverableTitles:
          source.artifacts.find((candidate) => candidate.id === artifact.id)?.dependentDeliverableTitles ?? [],
        layer: artifact.primaryLayer,
      })),
  };

  const hygiene = {
    missingCustomerContextCount: artifacts.filter((artifact) => artifact.customerAccount.isUnassigned).length +
      deliverables.filter((deliverable) =>
        deliverable.customerAccounts.every((customer) => customer.isUnassigned),
      ).length,
    ambiguousGovernanceCount: deliverables.filter((deliverable) => deliverable.ambiguousCustomerContext).length,
    publicDeliverablesWithoutAttributionCount: deliverables.filter(
      (deliverable) =>
        deliverable.visibility === "public_material" &&
        (deliverable.customerAccounts.every((customer) => customer.isUnassigned) ||
          source.deliverables.find((candidate) => candidate.id === deliverable.id)?.createdBy == null),
    ).length,
    items: [] as Array<{
      key: string;
      label: string;
      detail: string;
      count: number;
    }>,
  };
  hygiene.items = [
    {
      key: "missing_customer_context",
      label: "Resources missing customer context",
      detail: "Artifacts or deliverables that are not mapped to a customer account.",
      count: hygiene.missingCustomerContextCount,
    },
    {
      key: "ambiguous_customer_context",
      label: "Resources with ambiguous governance",
      detail: "Bundle deliverables that currently mix artifacts from more than one customer bucket.",
      count: hygiene.ambiguousGovernanceCount,
    },
    {
      key: "public_without_attribution",
      label: "Public deliverables without clear attribution",
      detail: "Public materials that are missing customer context or a clear owner-generated attribution.",
      count: hygiene.publicDeliverablesWithoutAttributionCount,
    },
  ].filter((item) => item.count > 0);

  return {
    representative: source.representative,
    summary: {
      artifactCount: artifacts.length,
      pinnedArtifacts: source.artifacts.filter((artifact) => artifact.isPinned).length,
      orgOrCustomerGovernedArtifacts: artifacts.filter(
        (artifact) =>
          artifact.layers.includes("org_managed") || artifact.layers.includes("customer_account"),
      ).length,
      artifactOwnerOnlyActionCount: artifacts.reduce(
        (sum, artifact) => sum + artifact.ownerOnlyActions.length + artifact.restrictedActions.length,
        0,
      ),
      deliverableCount: deliverables.length,
      publicMaterials: deliverables.filter((deliverable) => deliverable.visibility === "public_material").length,
      ownerOnlyDeliverables: deliverables.filter((deliverable) => deliverable.visibility === "owner_only").length,
      cachedPackages: deliverables.filter((deliverable) => deliverable.hasCachedPackage).length,
      orgOrCustomerGovernedDeliverables: deliverables.filter(
        (deliverable) =>
          deliverable.layers.includes("org_managed") || deliverable.layers.includes("customer_account"),
      ).length,
      deliverableOwnerOnlyActionCount: deliverables.reduce(
        (sum, deliverable) => sum + deliverable.ownerOnlyActions.length + deliverable.restrictedActions.length,
        0,
      ),
    },
    byGovernanceLayer,
    byCustomerAccount: customerBuckets,
    riskyActions,
    hygiene,
    artifacts,
    deliverables,
  };
}

function resolveArtifactCustomerAccount(
  contactId: string | null,
  contactAssignments: Map<string, GovernanceContactAssignment>,
  customerAccounts: Map<string, GovernanceCustomerAccount>,
) {
  if (!contactId) {
    return createUnassignedCustomerRef();
  }

  const assignment = contactAssignments.get(contactId);
  if (!assignment?.customerAccountId) {
    return createUnassignedCustomerRef();
  }

  const account = customerAccounts.get(assignment.customerAccountId) ??
    (assignment.customerAccountSlug ? customerAccounts.get(assignment.customerAccountSlug) : undefined);
  if (!account) {
    return {
      key: assignment.customerAccountId,
      slug: assignment.customerAccountSlug ?? "unknown-account",
      displayName: assignment.customerAccountSlug ?? "Unknown customer",
      isUnassigned: false,
    };
  }

  return {
    key: account.id ?? account.slug,
    slug: account.slug,
    displayName: account.displayName,
    isUnassigned: false,
  };
}

function resolveDeliverableCustomerAccounts(
  deliverable: ResourceGovernanceSource["deliverables"][number],
  artifactAccountLookup: Map<
    string,
    {
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
    }
  >,
) {
  const values: Array<{
    key: string;
    slug: string;
    displayName: string;
    isUnassigned: boolean;
  }> = [];

  if (deliverable.artifactId) {
    const customer = artifactAccountLookup.get(deliverable.artifactId);
    if (customer) {
      values.push(customer);
    }
  }

  for (const artifactId of deliverable.bundleItemArtifactIds) {
    const customer = artifactAccountLookup.get(artifactId);
    if (customer) {
      values.push(customer);
    }
  }

  return dedupeCustomerRefs(values);
}

function dedupeCustomerRefs(
  values: Array<{
    key: string;
    slug: string;
    displayName: string;
    isUnassigned: boolean;
  }>,
) {
  const seen = new Set<string>();
  const deduped: typeof values = [];
  for (const value of values) {
    if (seen.has(value.key)) {
      continue;
    }
    seen.add(value.key);
    deduped.push(value);
  }
  return deduped;
}

function resolveResourceLayers(input: {
  hasCustomerAccount: boolean;
  hasOrganization: boolean;
  isPublicMaterial: boolean;
  hasBundleSafety: boolean;
}) {
  const layers: GovernanceLayer[] = ["owner_managed"];
  if (input.hasOrganization) {
    layers.push("org_managed");
  }
  if (input.hasCustomerAccount) {
    layers.push("customer_account");
  } else {
    layers.push("unassigned_default");
  }
  if (input.isPublicMaterial || input.hasBundleSafety) {
    layers.push("delegate_managed");
  }
  return dedupeLayers(layers);
}

function dedupeLayers(layers: GovernanceLayer[]) {
  return governanceLayerOrder.filter((layer) => layers.includes(layer));
}

function resolvePrimaryLayer(layers: GovernanceLayer[]) {
  if (layers.includes("customer_account")) {
    return "customer_account" as GovernanceLayer;
  }
  if (layers.includes("org_managed")) {
    return "org_managed" as GovernanceLayer;
  }
  if (layers.includes("owner_managed")) {
    return "owner_managed" as GovernanceLayer;
  }
  if (layers.includes("delegate_managed")) {
    return "delegate_managed" as GovernanceLayer;
  }
  return "unassigned_default" as GovernanceLayer;
}

function createUnassignedCustomerRef() {
  return {
    key: "unassigned",
    slug: "unassigned",
    displayName: "Unassigned",
    isUnassigned: true,
  };
}

function buildCustomerBuckets(
  artifacts: RepresentativeResourceGovernanceSnapshot["artifacts"],
  deliverables: RepresentativeResourceGovernanceSnapshot["deliverables"],
) {
  const map = new Map<
    string,
    {
      key: string;
      slug: string;
      displayName: string;
      isUnassigned: boolean;
      visibleArtifactCount: number;
      deliverableCount: number;
      publicMaterialCount: number;
      restrictedActionCount: number;
    }
  >();

  for (const artifact of artifacts) {
    const current = map.get(artifact.customerAccount.key) ?? {
      key: artifact.customerAccount.key,
      slug: artifact.customerAccount.slug,
      displayName: artifact.customerAccount.displayName,
      isUnassigned: artifact.customerAccount.isUnassigned,
      visibleArtifactCount: 0,
      deliverableCount: 0,
      publicMaterialCount: 0,
      restrictedActionCount: 0,
    };
    current.visibleArtifactCount += 1;
    current.restrictedActionCount += artifact.ownerOnlyActions.length + artifact.restrictedActions.length;
    map.set(current.key, current);
  }

  for (const deliverable of deliverables) {
    const targets = deliverable.customerAccounts.length ? deliverable.customerAccounts : [createUnassignedCustomerRef()];
    for (const customer of targets) {
      const current = map.get(customer.key) ?? {
        key: customer.key,
        slug: customer.slug,
        displayName: customer.displayName,
        isUnassigned: customer.isUnassigned,
        visibleArtifactCount: 0,
        deliverableCount: 0,
        publicMaterialCount: 0,
        restrictedActionCount: 0,
      };
      current.deliverableCount += 1;
      if (deliverable.visibility === "public_material") {
        current.publicMaterialCount += 1;
      }
      current.restrictedActionCount += deliverable.ownerOnlyActions.length + deliverable.restrictedActions.length;
      map.set(current.key, current);
    }
  }

  return [...map.values()].sort((left, right) => {
    if (left.isUnassigned !== right.isUnassigned) {
      return left.isUnassigned ? 1 : -1;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}
