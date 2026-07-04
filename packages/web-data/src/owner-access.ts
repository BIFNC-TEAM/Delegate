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

function shouldAllowDemoRepresentativeAccess(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}
