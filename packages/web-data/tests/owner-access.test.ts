import { describe, expect, it } from "vitest";

import {
  RepresentativeAccessError,
  assertOwnerCanAccessRepresentative,
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
