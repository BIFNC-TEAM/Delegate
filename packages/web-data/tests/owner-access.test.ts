import { describe, expect, it } from "vitest";

import {
  RepresentativeAccessError,
  assertOwnerCanAccessRepresentative,
  assertOwnerCanApproveCompute,
  assertOwnerCanManageSkills,
} from "../src/owner-access";

describe("owner representative access", () => {
  it("allows an owner to access their own representative", async () => {
    const client = new FakeOwnerAccessClient([
      {
        id: "rep-1",
        slug: "ada-founder-rep",
        ownerId: "owner-1",
      },
    ]);

    await expect(
      assertOwnerCanAccessRepresentative(
        {
          ownerId: "owner-1",
          representativeSlug: "ada-founder-rep",
        },
        client,
      ),
    ).resolves.toMatchObject({
      id: "rep-1",
      ownerId: "owner-1",
    });
  });

  it("rejects a different owner", async () => {
    const client = new FakeOwnerAccessClient([
      {
        id: "rep-1",
        slug: "ada-founder-rep",
        ownerId: "owner-1",
      },
    ]);

    await expect(
      assertOwnerCanAccessRepresentative(
        {
          ownerId: "owner-2",
          representativeSlug: "ada-founder-rep",
        },
        client,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("requires an authenticated owner id", async () => {
    await expect(
      assertOwnerCanAccessRepresentative(
        {
          ownerId: null,
          representativeSlug: "lin-founder-rep",
        },
        new FakeOwnerAccessClient([]),
      ),
    ).rejects.toBeInstanceOf(RepresentativeAccessError);
  });
});

describe("owner organization permissions", () => {
  it("keeps personal owners fully authorized by default", async () => {
    const loadOwner = async () => ({
      organizationId: null,
      organizationMember: null,
    });

    await expect(assertOwnerCanApproveCompute("owner-1", loadOwner)).resolves.toBeUndefined();
    await expect(assertOwnerCanManageSkills("owner-1", loadOwner)).resolves.toBeUndefined();
  });

  it("allows an organization member only when the membership matches and grants the permission", async () => {
    const loadOwner = async () => ({
      organizationId: "org-1",
      organizationMember: {
        organizationId: "org-1",
        canApproveCompute: true,
        canManagePolicies: true,
      },
    });

    await expect(assertOwnerCanApproveCompute("owner-1", loadOwner)).resolves.toBeUndefined();
    await expect(assertOwnerCanManageSkills("owner-1", loadOwner)).resolves.toBeUndefined();
  });

  it.each([
    ["missing membership", {
      organizationId: "org-1",
      organizationMember: null,
    }],
    ["membership for another organization", {
      organizationId: "org-1",
      organizationMember: {
        organizationId: "org-2",
        canApproveCompute: true,
        canManagePolicies: true,
      },
    }],
  ])("fails closed for %s", async (_label, owner) => {
    const loadOwner = async () => owner;

    await expect(assertOwnerCanApproveCompute("owner-1", loadOwner)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertOwnerCanManageSkills("owner-1", loadOwner)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("enforces each organization permission independently", async () => {
    const loadOwner = async () => ({
      organizationId: "org-1",
      organizationMember: {
        organizationId: "org-1",
        canApproveCompute: false,
        canManagePolicies: true,
      },
    });

    await expect(assertOwnerCanApproveCompute("owner-1", loadOwner)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertOwnerCanManageSkills("owner-1", loadOwner)).resolves.toBeUndefined();
  });

  it("denies a dangling authenticated owner id", async () => {
    const loadOwner = async () => null;

    await expect(assertOwnerCanApproveCompute("owner-missing", loadOwner)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertOwnerCanManageSkills("owner-missing", loadOwner)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

type RepresentativeRow = {
  id: string;
  slug: string;
  ownerId: string;
};

class FakeOwnerAccessClient {
  constructor(private readonly representatives: RepresentativeRow[]) {}

  representative = {
    findUnique: async (args: any) => {
      return this.representatives.find((representative) => representative.slug === args.where.slug) ?? null;
    },
  };
}
