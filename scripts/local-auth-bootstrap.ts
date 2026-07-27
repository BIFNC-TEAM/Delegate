import {
  OwnerIdentityLinkProvider,
  PrismaClient,
} from "@prisma/client";
import { pathToFileURL } from "node:url";

const DEMO_REPRESENTATIVE_ID = "rep_lin_founder";
const DEMO_REPRESENTATIVE_SLUG = "lin-founder-rep";
const DEFAULT_DEV_OWNER_SUBJECT = "delegate-dev-owner";
const DEFAULT_DEV_OWNER_EMAIL = "creator@delegate.local";

type LocalAuthBootstrapClient = Pick<
  PrismaClient,
  "ownerIdentityLink" | "representative"
>;

export async function bootstrapLocalOwnerAuth(
  client: LocalAuthBootstrapClient,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.NODE_ENV !== "development") {
    throw new Error(
      "Local auth bootstrap is only allowed when NODE_ENV=development.",
    );
  }
  if (!isEnabled(env.DELEGATE_LOCAL_AUTH_BOOTSTRAP)) {
    throw new Error(
      "DELEGATE_LOCAL_AUTH_BOOTSTRAP must be enabled for local auth bootstrap.",
    );
  }
  if (!isEnabled(env.DELEGATE_AUTH_DEV_LOGIN)) {
    throw new Error("DELEGATE_AUTH_DEV_LOGIN must be enabled for local auth bootstrap.");
  }

  const representative = await client.representative.findUnique({
    where: { slug: DEMO_REPRESENTATIVE_SLUG },
    select: { id: true, ownerId: true },
  });
  if (!representative || representative.id !== DEMO_REPRESENTATIVE_ID) {
    throw new Error(
      `Local auth bootstrap requires the "${DEMO_REPRESENTATIVE_SLUG}" demo fixture.`,
    );
  }

  const providerSubject =
    env.DELEGATE_AUTH_DEV_OWNER_SUBJECT?.trim() || DEFAULT_DEV_OWNER_SUBJECT;
  const existingLink = await client.ownerIdentityLink.findUnique({
    where: {
      provider_providerSubject: {
        provider: OwnerIdentityLinkProvider.LOGTO,
        providerSubject,
      },
    },
    select: { ownerId: true },
  });
  if (existingLink && existingLink.ownerId !== representative.ownerId) {
    throw new Error(
      `Development auth subject "${providerSubject}" already belongs to another owner.`,
    );
  }

  const verifiedAt = new Date();
  await client.ownerIdentityLink.upsert({
    where: {
      provider_providerSubject: {
        provider: OwnerIdentityLinkProvider.LOGTO,
        providerSubject,
      },
    },
    create: {
      ownerId: representative.ownerId,
      provider: OwnerIdentityLinkProvider.LOGTO,
      providerSubject,
      email:
        env.DELEGATE_AUTH_DEV_OWNER_EMAIL?.trim() || DEFAULT_DEV_OWNER_EMAIL,
      verifiedAt,
      metadata: {
        mode: "development",
        actor: "owner",
        fixture: "local-compose-bootstrap",
      },
    },
    update: {
      email:
        env.DELEGATE_AUTH_DEV_OWNER_EMAIL?.trim() || DEFAULT_DEV_OWNER_EMAIL,
      verifiedAt,
      metadata: {
        mode: "development",
        actor: "owner",
        fixture: "local-compose-bootstrap",
      },
    },
  });

  return {
    ownerId: representative.ownerId,
    providerSubject,
  };
}

function isEnabled(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() || "");
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await bootstrapLocalOwnerAuth(prisma);
    console.log(`Local development owner is ready: ${result.ownerId}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Local auth bootstrap failed.",
    );
    process.exitCode = 1;
  });
}
