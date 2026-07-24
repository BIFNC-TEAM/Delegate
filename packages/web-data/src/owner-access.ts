import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";

type OwnerAccessRepresentative = {
  id: string;
  slug: string;
  ownerId: string;
};

type OwnerAccessClient = {
  representative: {
    findUnique(args: {
      where: { slug: string };
      select: {
        id: true;
        slug: true;
        ownerId: true;
      };
    }): Promise<OwnerAccessRepresentative | null>;
  };
};

type OwnerPermissionRecord = {
  organizationId: string | null;
  organizationMember: {
    organizationId: string;
    canApproveCompute: boolean;
    canManageBilling: boolean;
    canManagePolicies: boolean;
  } | null;
};

type OwnerPermissionLoader = (ownerId: string) => Promise<OwnerPermissionRecord | null>;

export class RepresentativeAccessError extends Error {
  statusCode: 401 | 403 | 404;

  constructor(message: string, statusCode: 401 | 403 | 404) {
    super(message);
    this.name = "RepresentativeAccessError";
    this.statusCode = statusCode;
  }
}

export async function assertOwnerCanAccessRepresentative(
  input: {
    ownerId: string | null | undefined;
    representativeSlug: string;
  },
  client: OwnerAccessClient = prisma,
): Promise<OwnerAccessRepresentative> {
  const ownerId = input.ownerId?.trim();
  if (!ownerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  const representativeSlug = input.representativeSlug.trim();
  if (!representativeSlug) {
    throw new RepresentativeAccessError("Representative slug is required.", 404);
  }

  if (shouldAllowDemoRepresentativeAccess(representativeSlug)) {
    return {
      id: demoRepresentative.id,
      slug: demoRepresentative.slug,
      ownerId,
    };
  }

  const representative = await client.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      ownerId: true,
    },
  });
  if (!representative) {
    throw new RepresentativeAccessError("Representative not found.", 404);
  }
  if (representative.ownerId !== ownerId) {
    throw new RepresentativeAccessError("You do not have access to this representative.", 403);
  }
  return representative;
}

export async function assertOwnerCanApproveCompute(
  ownerId: string | null | undefined,
  loadOwnerPermissions: OwnerPermissionLoader = loadPersistedOwnerPermissions,
) {
  const normalizedOwnerId = ownerId?.trim();
  if (!normalizedOwnerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  const owner = await loadOwnerPermissions(normalizedOwnerId);
  if (!hasOwnerOrganizationPermission(owner, "canApproveCompute")) {
    throw new RepresentativeAccessError("You do not have permission to approve Compute requests.", 403);
  }
}

export async function assertOwnerCanManageSkills(
  ownerId: string | null | undefined,
  loadOwnerPermissions: OwnerPermissionLoader = loadPersistedOwnerPermissions,
) {
  const normalizedOwnerId = ownerId?.trim();
  if (!normalizedOwnerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  const owner = await loadOwnerPermissions(normalizedOwnerId);
  if (!hasOwnerOrganizationPermission(owner, "canManagePolicies")) {
    throw new RepresentativeAccessError(
      "You do not have permission to manage workspace skills or capability policy.",
      403,
    );
  }
}

export async function assertOwnerCanManageBilling(
  ownerId: string | null | undefined,
  loadOwnerPermissions: OwnerPermissionLoader = loadPersistedOwnerPermissions,
) {
  const normalizedOwnerId = ownerId?.trim();
  if (!normalizedOwnerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  const owner = await loadOwnerPermissions(normalizedOwnerId);
  if (!hasOwnerOrganizationPermission(owner, "canManageBilling")) {
    throw new RepresentativeAccessError(
      "You do not have permission to manage workspace billing.",
      403,
    );
  }
}

export async function assertOwnerCanResolveApproval(input: {
  ownerId: string | null | undefined;
  representativeSlug: string;
  approvalId: string;
}) {
  const normalizedOwnerId = input.ownerId?.trim();
  if (!normalizedOwnerId) {
    throw new RepresentativeAccessError("Authentication required.", 401);
  }
  const approval = await prisma.approvalRequest.findFirst({
    where: {
      id: input.approvalId,
      representative: {
        slug: input.representativeSlug,
        ownerId: normalizedOwnerId,
      },
    },
    select: { workspaceSkillReleaseId: true },
  });
  if (!approval) {
    throw new RepresentativeAccessError("Approval request not found.", 404);
  }
  if (approval.workspaceSkillReleaseId) {
    await assertOwnerCanManageSkills(normalizedOwnerId);
    return "skill_update" as const;
  }
  await assertOwnerCanApproveCompute(normalizedOwnerId);
  return "compute" as const;
}

function hasOwnerOrganizationPermission(
  owner: OwnerPermissionRecord | null,
  permission: "canApproveCompute" | "canManageBilling" | "canManagePolicies",
) {
  if (!owner) return false;
  if (owner.organizationId === null) return true;
  return owner.organizationMember?.organizationId === owner.organizationId
    && owner.organizationMember[permission];
}

async function loadPersistedOwnerPermissions(
  ownerId: string,
): Promise<OwnerPermissionRecord | null> {
  return prisma.owner.findUnique({
    where: { id: ownerId },
    select: {
      organizationId: true,
      organizationMember: {
        select: {
          organizationId: true,
          canApproveCompute: true,
          canManageBilling: true,
          canManagePolicies: true,
        },
      },
    },
  });
}

function shouldAllowDemoRepresentativeAccess(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}
