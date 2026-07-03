import { createHash } from "node:crypto";

import JSZip from "jszip";
import { Prisma } from "@prisma/client";
import { demoRepresentative } from "@delegate/domain";
import {
  listDeliverablePackagingPresetsResponseSchema,
  deliverableDownloadResponseSchema,
  listDeliverablesResponseSchema,
  maxDeliverableBundleItems,
  representativeDeliverableInsightsSnapshotSchema,
  updateDeliverableRequestSchema,
  upsertDeliverableRequestSchema,
  type DeliverableDownloadResponse,
  type ListDeliverablePackagingPresetsResponse,
  type ListDeliverablesResponse,
  type RepresentativeDeliverableInsightsSnapshot,
  type UpdateDeliverableRequest,
  type UpsertDeliverableRequest,
} from "@delegate/compute-protocol";

import { readArtifactObject, writeArtifactObject } from "./artifact-store";
import {
  buildDeliverablePackagingPresets,
  buildRepresentativeDeliverableInsights,
  computeDeliverablePackageCacheKey,
} from "./deliverable-insights";
import { prisma } from "./prisma";

const maxDeliverableBundleBytes = 25 * 1024 * 1024;

const deliverableInclude = Prisma.validator<Prisma.DeliverableDefaultArgs>()({
  include: {
    representative: {
      select: {
        id: true,
        slug: true,
        displayName: true,
      },
    },
    artifact: true,
  },
});

type DeliverableRecord = Prisma.DeliverableGetPayload<{
  include: typeof deliverableInclude.include;
}>;

type ArtifactRecord = Prisma.ArtifactGetPayload<{
  include: {
    representative: {
      select: {
        slug: true;
      };
    };
  };
}>;

export type UpsertRepresentativeDeliverableInput = {
  representativeSlug: string;
  deliverableId?: string;
  body: unknown;
};

export async function getRepresentativeDeliverables(
  representativeSlug: string,
  options?: {
    publicOnly?: boolean;
  },
): Promise<ListDeliverablesResponse | null> {
  if (shouldUseStaticDeliverableFallback(representativeSlug)) {
    return getDemoDeliverablesFallback();
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      select: {
        id: true,
        slug: true,
        displayName: true,
      },
    });

    if (!representative) {
      return null;
    }

    const deliverables = await prisma.deliverable.findMany({
      where: {
        representativeId: representative.id,
        ...(options?.publicOnly ? { visibility: "PUBLIC_MATERIAL" } : {}),
      },
      include: {
        artifact: {
          select: {
            id: true,
            mimeType: true,
            sizeBytes: true,
            summary: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    return listDeliverablesResponseSchema.parse({
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
      },
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        representativeId: deliverable.representativeId,
        artifactId: deliverable.artifactId,
        title: deliverable.title,
        summary: deliverable.summary,
        kind: deliverable.kind.toLowerCase(),
        visibility: deliverable.visibility.toLowerCase(),
        sourceKind: deliverable.sourceKind.toLowerCase(),
        externalUrl: deliverable.externalUrl,
        bundleItemArtifactIds: deliverable.bundleItemArtifactIds,
        downloadCount: deliverable.downloadCount,
        lastDownloadedAt: deliverable.lastDownloadedAt?.toISOString() ?? null,
        packageBuiltAt: deliverable.packageBuiltAt?.toISOString() ?? null,
        packageSizeBytes: deliverable.packageSizeBytes ?? null,
        hasCachedPackage: Boolean(deliverable.packageObjectKey && deliverable.packageBuiltAt),
        createdBy: deliverable.createdBy,
        createdAt: deliverable.createdAt.toISOString(),
        updatedAt: deliverable.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    if (shouldUseDemoFallback(error, representativeSlug)) {
      return getDemoDeliverablesFallback();
    }
    throw error;
  }
}

export async function getRepresentativeDeliverableInsights(
  representativeSlug: string,
): Promise<RepresentativeDeliverableInsightsSnapshot | null> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
    },
  });

  if (!representative) {
    return null;
  }

  const [deliverables, artifacts] = await Promise.all([
    prisma.deliverable.findMany({
      where: {
        representativeId: representative.id,
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.artifact.findMany({
      where: {
        representativeId: representative.id,
        isPinned: true,
      },
      select: {
        id: true,
        kind: true,
        isPinned: true,
        sizeBytes: true,
        createdAt: true,
      },
    }),
  ]);

  return representativeDeliverableInsightsSnapshotSchema.parse(
    buildRepresentativeDeliverableInsights({
      representative: {
        slug: representative.slug,
        displayName: representative.displayName,
      },
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        summary: deliverable.summary,
        kind: deliverable.kind.toLowerCase() as
          | "deck"
          | "case_study"
          | "download"
          | "generated_document"
          | "package",
        visibility: deliverable.visibility.toLowerCase() as "owner_only" | "public_material",
        sourceKind: deliverable.sourceKind.toLowerCase() as "artifact" | "external_link" | "bundle",
        artifactId: deliverable.artifactId,
        bundleItemArtifactIds: deliverable.bundleItemArtifactIds,
        downloadCount: deliverable.downloadCount,
        lastDownloadedAt: deliverable.lastDownloadedAt?.toISOString() ?? null,
        updatedAt: deliverable.updatedAt.toISOString(),
        packageBuiltAt: deliverable.packageBuiltAt?.toISOString() ?? null,
        packageSizeBytes: deliverable.packageSizeBytes,
        packageCacheKey: deliverable.packageCacheKey,
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind.toLowerCase() as
          | "stdout"
          | "stderr"
          | "file"
          | "archive"
          | "screenshot"
          | "json"
          | "trace",
        isPinned: artifact.isPinned,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt.toISOString(),
      })),
    }),
  );
}

export async function getRepresentativeDeliverablePackagingPresets(
  representativeSlug: string,
): Promise<ListDeliverablePackagingPresetsResponse | null> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
    },
  });

  if (!representative) {
    return null;
  }

  const artifacts = await prisma.artifact.findMany({
    where: {
      representativeId: representative.id,
      isPinned: true,
    },
    select: {
      id: true,
      kind: true,
      isPinned: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return listDeliverablePackagingPresetsResponseSchema.parse({
    representative: {
      slug: representative.slug,
      displayName: representative.displayName,
    },
    presets: buildDeliverablePackagingPresets({
      representativeDisplayName: representative.displayName,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind.toLowerCase() as
          | "stdout"
          | "stderr"
          | "file"
          | "archive"
          | "screenshot"
          | "json"
          | "trace",
        isPinned: artifact.isPinned,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt.toISOString(),
      })),
    }),
  });
}

export async function upsertRepresentativeDeliverable(
  input: UpsertRepresentativeDeliverableInput,
) {
  const representative = await prisma.representative.findUnique({
    where: { slug: input.representativeSlug },
    select: {
      id: true,
      slug: true,
      displayName: true,
    },
  });

  if (!representative) {
    throw new Error(`Representative "${input.representativeSlug}" not found.`);
  }

  const parsed = input.deliverableId
    ? updateDeliverableRequestSchema.parse(input.body)
    : upsertDeliverableRequestSchema.parse(input.body);
  const existing = input.deliverableId
    ? await prisma.deliverable.findFirst({
        where: {
          id: input.deliverableId,
          representativeId: representative.id,
        },
      })
    : null;

  if (input.deliverableId && !existing) {
    throw new Error("Deliverable not found for this representative.");
  }

  const nextShape = resolveNextDeliverableShape(existing, parsed);
  const artifactId = await resolveDeliverableArtifactBinding(representative.id, nextShape);

  const persisted = existing
    ? await prisma.deliverable.update({
        where: { id: existing.id },
        data: {
          title: nextShape.title,
          summary: nextShape.summary,
          kind: toDbDeliverableKind(nextShape.kind),
          visibility: toDbDeliverableVisibility(nextShape.visibility),
          sourceKind: toDbDeliverableSourceKind(nextShape.sourceKind),
          artifactId,
          externalUrl: nextShape.sourceKind === "external_link" ? nextShape.externalUrl ?? null : null,
          bundleItemArtifactIds:
            nextShape.sourceKind === "bundle" ? nextShape.bundleItemArtifactIds : [],
          ...(nextShape.sourceKind === "bundle"
            ? {}
            : {
                packageObjectKey: null,
                packageMimeType: null,
                packageSizeBytes: null,
                packageSha256: null,
                packageBuiltAt: null,
                packageCacheKey: null,
              }),
          createdBy: nextShape.createdBy ?? existing.createdBy,
        },
      })
    : await prisma.deliverable.create({
        data: {
          representativeId: representative.id,
          title: nextShape.title,
          summary: nextShape.summary,
          kind: toDbDeliverableKind(nextShape.kind),
          visibility: toDbDeliverableVisibility(nextShape.visibility),
          sourceKind: toDbDeliverableSourceKind(nextShape.sourceKind),
          artifactId,
          externalUrl: nextShape.sourceKind === "external_link" ? nextShape.externalUrl ?? null : null,
          bundleItemArtifactIds:
            nextShape.sourceKind === "bundle" ? nextShape.bundleItemArtifactIds : [],
          createdBy: nextShape.createdBy ?? "owner-dashboard",
        },
      });

  if (nextShape.sourceKind === "bundle") {
    await ensurePersistedDeliverablePackage({
      representativeSlug: representative.slug,
      representativeId: representative.id,
      deliverableId: persisted.id,
      deliverableTitle: nextShape.title,
      bundleItemArtifactIds: nextShape.bundleItemArtifactIds,
    });
  }

  const result = await prisma.deliverable.findUnique({
    where: { id: persisted.id },
    ...deliverableInclude,
  });

  if (!result) {
    throw new Error("Deliverable was saved but could not be reloaded.");
  }

  return serializeDeliverable(result);
}

export async function getRepresentativeDeliverableDownload(
  representativeSlug: string,
  deliverableId: string,
  options?: {
    publicOnly?: boolean;
    recordDownload?: boolean;
  },
): Promise<(DeliverableDownloadResponse & { buffer: Buffer }) | null> {
  const deliverable = await getRepresentativeDeliverableRecord(representativeSlug, deliverableId, {
    ...(options?.publicOnly ? { publicOnly: true } : {}),
  });

  if (!deliverable) {
    return null;
  }

  if (deliverable.sourceKind === "EXTERNAL_LINK") {
    throw new Error("External-link deliverables should be opened directly from their URL.");
  }

  if (deliverable.sourceKind === "ARTIFACT") {
    if (!deliverable.artifactId) {
      throw new Error("Artifact-backed deliverable is missing its artifact.");
    }

    const artifact = await prisma.artifact.findFirst({
      where: {
        id: deliverable.artifactId,
        representativeId: deliverable.representativeId,
      },
      include: {
        representative: {
          select: {
            slug: true,
            displayName: true,
            computeArtifactRetentionDays: true,
          },
        },
      },
    });

    if (!artifact) {
      throw new Error("Deliverable artifact not found.");
    }

    const { buffer } = await readArtifactObject(artifact.objectKey);
    if (options?.recordDownload !== false) {
      await Promise.all([
        recordArtifactDownload(artifact, buffer.byteLength),
        recordDeliverableDownload(deliverable.id),
      ]);
    }

    return {
      ...deliverableDownloadResponseSchema.parse({
        fileName: buildDeliverableFileName(
          deliverable.title,
          artifact.mimeType,
          buildArtifactFileName(artifact),
        ),
        mimeType: artifact.mimeType,
      }),
      buffer,
    };
  }

  const { buffer } = await readPersistedDeliverablePackage(deliverable);

  if (options?.recordDownload !== false) {
    await Promise.all([
      recordDeliverableDownload(deliverable.id),
      prisma.ledgerEntry.create({
        data: {
          representativeId: deliverable.representativeId,
          kind: "ARTIFACT_EGRESS",
          quantity: buffer.byteLength,
          unit: "byte",
          costCents: Math.max(1, Math.ceil(buffer.byteLength / 65536)),
          creditDelta: 0,
          notes: `deliverable_bundle_download:${deliverable.id}`,
        },
      }),
    ]);
  }

  return {
    ...deliverableDownloadResponseSchema.parse({
      fileName: buildDeliverableFileName(deliverable.title, "application/zip", `${deliverable.id}.zip`),
      mimeType: "application/zip",
    }),
    buffer,
  };
}

export async function getRepresentativePublicDeliverables(representativeSlug: string) {
  return getRepresentativeDeliverables(representativeSlug, {
    publicOnly: true,
  });
}

function getDemoDeliverablesFallback(): ListDeliverablesResponse {
  return listDeliverablesResponseSchema.parse({
    representative: {
      slug: demoRepresentative.slug,
      displayName: demoRepresentative.name,
    },
    deliverables: [],
  });
}

function shouldUseStaticDeliverableFallback(representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && !process.env.DATABASE_URL?.trim();
}

function shouldUseDemoFallback(error: unknown, representativeSlug: string): boolean {
  return representativeSlug === demoRepresentative.slug && isPrismaUnavailableError(error);
}

function isPrismaUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Environment variable not found: DATABASE_URL") ||
    error.message.includes("Can't reach database server") ||
    error.message.includes("Timed out fetching a new connection")
  );
}

function resolveNextDeliverableShape(
  existing: {
    title: string;
    summary: string;
    kind: string;
    visibility: string;
    sourceKind: string;
    artifactId: string | null;
    externalUrl: string | null;
    bundleItemArtifactIds: string[];
    createdBy: string | null;
  } | null,
  input: UpsertDeliverableRequest | UpdateDeliverableRequest,
) {
  const current = existing
    ? {
        title: existing.title,
        summary: existing.summary,
        kind: existing.kind.toLowerCase() as "deck" | "case_study" | "download" | "generated_document" | "package",
        visibility: existing.visibility.toLowerCase() as "owner_only" | "public_material",
        sourceKind: existing.sourceKind.toLowerCase() as "artifact" | "external_link" | "bundle",
        artifactId: existing.artifactId ?? undefined,
        externalUrl: existing.externalUrl ?? undefined,
        bundleItemArtifactIds: existing.bundleItemArtifactIds,
        createdBy: existing.createdBy ?? undefined,
      }
    : null;

  const merged = {
    title: input.title ?? current?.title,
    summary: input.summary ?? current?.summary,
    kind: input.kind ?? current?.kind,
    visibility: input.visibility ?? current?.visibility ?? "owner_only",
    sourceKind: input.sourceKind ?? current?.sourceKind,
    artifactId: input.artifactId ?? current?.artifactId,
    externalUrl: input.externalUrl ?? current?.externalUrl,
    bundleItemArtifactIds: input.bundleItemArtifactIds ?? current?.bundleItemArtifactIds ?? [],
    createdBy: input.createdBy ?? current?.createdBy,
  };

  return upsertDeliverableRequestSchema.parse(merged);
}

async function resolveDeliverableArtifactBinding(
  representativeId: string,
  input: UpsertDeliverableRequest,
) {
  if (input.sourceKind === "external_link") {
    return null;
  }

  if (input.sourceKind === "artifact") {
    const artifactId = input.artifactId;
    if (!artifactId) {
      throw new Error("Artifact-backed deliverable is missing an artifact id.");
    }
    const artifact = await prisma.artifact.findFirst({
      where: {
        id: artifactId,
        representativeId,
      },
      select: {
        id: true,
        isPinned: true,
      },
    });

    if (!artifact) {
      throw new Error("Artifact not found for this representative.");
    }

    if (!artifact.isPinned) {
      await prisma.artifact.update({
        where: { id: artifact.id },
        data: {
          isPinned: true,
          pinnedAt: new Date(),
          pinnedBy: input.createdBy ?? "deliverable-link",
          retentionUntil: null,
        },
      });
    }

    return artifact.id;
  }

  const bundleArtifacts = await prisma.artifact.findMany({
    where: {
      representativeId,
      id: {
        in: input.bundleItemArtifactIds,
      },
    },
    select: {
      id: true,
      isPinned: true,
      sizeBytes: true,
    },
  });

  if (bundleArtifacts.length !== input.bundleItemArtifactIds.length) {
    throw new Error("Some bundle artifacts are missing or belong to another representative.");
  }

  const unpinned = bundleArtifacts.find((artifact) => !artifact.isPinned);
  if (unpinned) {
    throw new Error("Bundle deliverables may only package pinned artifacts.");
  }

  const totalSourceBytes = bundleArtifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  if (totalSourceBytes > maxDeliverableBundleBytes) {
    throw new Error(
      `Bundle deliverables may include at most ${formatBytes(maxDeliverableBundleBytes)} of source artifacts.`,
    );
  }

  return null;
}

async function getRepresentativeDeliverableRecord(
  representativeSlug: string,
  deliverableId: string,
  options?: {
    publicOnly?: boolean;
  },
): Promise<DeliverableRecord | null> {
  return prisma.deliverable.findFirst({
    where: {
      id: deliverableId,
      representative: {
        slug: representativeSlug,
      },
      ...(options?.publicOnly ? { visibility: "PUBLIC_MATERIAL" } : {}),
    },
    ...deliverableInclude,
  });
}

async function loadBundleArtifacts(representativeId: string, artifactIds: string[]) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      representativeId,
      id: {
        in: artifactIds,
      },
    },
    include: {
      representative: {
        select: {
          slug: true,
        },
      },
    },
  });

  if (artifacts.length !== artifactIds.length) {
    throw new Error("Bundle artifacts could not be resolved.");
  }

  const order = new Map(artifactIds.map((artifactId, index) => [artifactId, index]));
  return artifacts.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

function serializeDeliverable(deliverable: DeliverableRecord) {
  return {
    id: deliverable.id,
    representativeId: deliverable.representativeId,
    artifactId: deliverable.artifactId,
    title: deliverable.title,
    summary: deliverable.summary,
    kind: deliverable.kind.toLowerCase() as
      | "deck"
      | "case_study"
      | "download"
      | "generated_document"
      | "package",
    visibility: deliverable.visibility.toLowerCase() as "owner_only" | "public_material",
    sourceKind: deliverable.sourceKind.toLowerCase() as "artifact" | "external_link" | "bundle",
    externalUrl: deliverable.externalUrl,
    bundleItemArtifactIds: deliverable.bundleItemArtifactIds,
    downloadCount: deliverable.downloadCount,
    lastDownloadedAt: deliverable.lastDownloadedAt?.toISOString() ?? null,
    packageBuiltAt: deliverable.packageBuiltAt?.toISOString() ?? null,
    packageSizeBytes: deliverable.packageSizeBytes ?? null,
    hasCachedPackage: Boolean(deliverable.packageObjectKey && deliverable.packageBuiltAt),
    createdBy: deliverable.createdBy,
    createdAt: deliverable.createdAt.toISOString(),
    updatedAt: deliverable.updatedAt.toISOString(),
  };
}

function toDbDeliverableKind(
  value: "deck" | "case_study" | "download" | "generated_document" | "package",
): "DECK" | "CASE_STUDY" | "DOWNLOAD" | "GENERATED_DOCUMENT" | "PACKAGE" {
  switch (value) {
    case "deck":
      return "DECK";
    case "case_study":
      return "CASE_STUDY";
    case "download":
      return "DOWNLOAD";
    case "generated_document":
      return "GENERATED_DOCUMENT";
    case "package":
      return "PACKAGE";
  }
}

function toDbDeliverableVisibility(
  value: "owner_only" | "public_material",
): "OWNER_ONLY" | "PUBLIC_MATERIAL" {
  return value === "public_material" ? "PUBLIC_MATERIAL" : "OWNER_ONLY";
}

function toDbDeliverableSourceKind(
  value: "artifact" | "external_link" | "bundle",
): "ARTIFACT" | "EXTERNAL_LINK" | "BUNDLE" {
  switch (value) {
    case "artifact":
      return "ARTIFACT";
    case "external_link":
      return "EXTERNAL_LINK";
    case "bundle":
      return "BUNDLE";
  }
}

async function recordArtifactDownload(
  artifact: {
    id: string;
    representativeId: string;
    contactId: string | null;
    conversationId: string | null;
    sessionId: string | null;
    toolExecutionId: string | null;
  },
  byteLength: number,
) {
  const now = new Date();
  const egressCostCents = Math.max(1, Math.ceil(byteLength / 65536));

  await prisma.$transaction([
    prisma.artifact.update({
      where: { id: artifact.id },
      data: {
        downloadCount: {
          increment: 1,
        },
        lastDownloadedAt: now,
      },
    }),
    prisma.ledgerEntry.create({
      data: {
        representativeId: artifact.representativeId,
        contactId: artifact.contactId,
        conversationId: artifact.conversationId,
        sessionId: artifact.sessionId,
        toolExecutionId: artifact.toolExecutionId,
        kind: "ARTIFACT_EGRESS",
        quantity: byteLength,
        unit: "byte",
        costCents: egressCostCents,
        creditDelta: 0,
        notes: "deliverable_artifact_download",
      },
    }),
  ]);
}

async function recordDeliverableDownload(deliverableId: string) {
  await prisma.deliverable.update({
    where: { id: deliverableId },
    data: {
      downloadCount: {
        increment: 1,
      },
      lastDownloadedAt: new Date(),
    },
  });
}

async function ensurePersistedDeliverablePackage(input: {
  representativeSlug: string;
  representativeId: string;
  deliverableId: string;
  deliverableTitle: string;
  bundleItemArtifactIds: string[];
}) {
  const bundleArtifacts = await loadBundleArtifacts(input.representativeId, input.bundleItemArtifactIds);
  const packagePayload = await buildBundlePackagePayload({
    representativeSlug: input.representativeSlug,
    deliverableId: input.deliverableId,
    deliverableTitle: input.deliverableTitle,
    bundleArtifacts,
  });

  await writeArtifactObject({
    objectKey: packagePayload.objectKey,
    body: packagePayload.buffer,
    contentType: "application/zip",
  });

  await prisma.deliverable.update({
    where: { id: input.deliverableId },
    data: {
      packageObjectKey: packagePayload.objectKey,
      packageMimeType: "application/zip",
      packageSizeBytes: packagePayload.buffer.byteLength,
      packageSha256: packagePayload.sha256,
      packageBuiltAt: new Date(),
      packageCacheKey: packagePayload.cacheKey,
    },
  });
}

async function readPersistedDeliverablePackage(deliverable: DeliverableRecord) {
  if (deliverable.packageObjectKey) {
    return readArtifactObject(deliverable.packageObjectKey);
  }

  const bundleArtifacts = await loadBundleArtifacts(
    deliverable.representativeId,
    deliverable.bundleItemArtifactIds,
  );
  const packagePayload = await buildBundlePackagePayload({
    representativeSlug: deliverable.representative.slug,
    deliverableId: deliverable.id,
    deliverableTitle: deliverable.title,
    bundleArtifacts,
  });

  await writeArtifactObject({
    objectKey: packagePayload.objectKey,
    body: packagePayload.buffer,
    contentType: "application/zip",
  });

  await prisma.deliverable.update({
    where: { id: deliverable.id },
    data: {
      packageObjectKey: packagePayload.objectKey,
      packageMimeType: "application/zip",
      packageSizeBytes: packagePayload.buffer.byteLength,
      packageSha256: packagePayload.sha256,
      packageBuiltAt: new Date(),
      packageCacheKey: packagePayload.cacheKey,
    },
  });

  return {
    buffer: packagePayload.buffer,
    contentType: "application/zip",
  };
}

async function buildBundlePackagePayload(input: {
  representativeSlug: string;
  deliverableId: string;
  deliverableTitle: string;
  bundleArtifacts: ArtifactRecord[];
}) {
  if (input.bundleArtifacts.length > maxDeliverableBundleItems) {
    throw new Error(
      `Bundle deliverables may include at most ${maxDeliverableBundleItems} artifacts.`,
    );
  }

  const totalSourceBytes = input.bundleArtifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  if (totalSourceBytes > maxDeliverableBundleBytes) {
    throw new Error(
      `Bundle deliverables may include at most ${formatBytes(maxDeliverableBundleBytes)} of source artifacts.`,
    );
  }

  const zip = new JSZip();
  const usedFileNames = new Set<string>();
  const artifactFingerprints: Array<{
    id: string;
    sha256: string;
    sizeBytes: number;
    fileName: string;
  }> = [];

  for (const artifact of input.bundleArtifacts) {
    const { buffer } = await readArtifactObject(artifact.objectKey);
    const fileName = ensureUniqueFileName(buildArtifactFileName(artifact), usedFileNames);
    artifactFingerprints.push({
      id: artifact.id,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      fileName,
    });
    zip.file(fileName, buffer);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const cacheKey = createHash("sha256")
    .update(
      computeDeliverablePackageCacheKey({
        representativeSlug: input.representativeSlug,
        deliverableId: input.deliverableId,
        artifactIds: input.bundleArtifacts.map((artifact) => artifact.id),
        artifactFingerprints,
      }),
    )
    .digest("hex");

  return {
    buffer,
    sha256,
    cacheKey,
    objectKey: buildDeliverablePackageObjectKey(
      input.representativeSlug,
      input.deliverableId,
      cacheKey,
    ),
  };
}

function ensureUniqueFileName(candidate: string, used: Set<string>) {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  const dotIndex = candidate.lastIndexOf(".");
  const stem = dotIndex >= 0 ? candidate.slice(0, dotIndex) : candidate;
  const extension = dotIndex >= 0 ? candidate.slice(dotIndex) : "";
  let counter = 2;
  let next = `${stem}-${counter}${extension}`;

  while (used.has(next)) {
    counter += 1;
    next = `${stem}-${counter}${extension}`;
  }

  used.add(next);
  return next;
}

function buildDeliverableFileName(title: string, mimeType: string, fallback: string) {
  const safeTitle = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const extension = extensionFromMimeType(mimeType);

  if (!safeTitle) {
    return fallback;
  }

  return extension ? `${safeTitle}.${extension}` : safeTitle;
}

function buildArtifactFileName(artifact: ArtifactRecord) {
  const extension = extensionFromMimeType(artifact.mimeType);
  const base = `${artifact.kind.toLowerCase()}-${artifact.id}`;
  return extension ? `${base}.${extension}` : base;
}

function buildDeliverablePackageObjectKey(
  representativeSlug: string,
  deliverableId: string,
  cacheKey: string,
) {
  return `deliverables/${representativeSlug}/${deliverableId}/${cacheKey}.zip`;
}

function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "application/json":
      return "json";
    case "application/zip":
      return "zip";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/pdf":
      return "pdf";
    default:
      return normalized?.split("/")[1] ?? "";
  }
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }

  return `${value} bytes`;
}
