import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import {
  KnowledgeAssetKind,
  KnowledgeAssetReviewStatus,
  KnowledgeAssetStatus,
  KnowledgeAssetUsageMode,
  KnowledgeAssetVisibility,
  KnowledgeProcessingLogLevel,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";

import { demoRepresentative } from "@delegate/domain";

import { prisma } from "./prisma";
import {
  buildKnowledgeOwnerObjectPrefix,
  deleteKnowledgeSource,
  readKnowledgeSource,
} from "./knowledge-storage";
import { indexKnowledgeText, removeKnowledgeTextIndex } from "./knowledge-vector";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SOURCE_CHARACTERS = 400_000;
const URL_TIMEOUT_MS = 12_000;

const assetKindSchema = z.enum(["pdf", "docx", "txt", "markdown", "url", "text"]);
const assetVisibilitySchema = z.enum([
  "owner_only",
  "organization_shared",
  "selected_representatives",
  "public_material",
]);
const usageModeSchema = z.enum(["qa_source", "public_material", "both"]);
const reviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
const fileAssetKindSchema = z.enum(["pdf", "docx", "txt", "markdown"]);

const representativeLinkSchema = z.object({
  representativeId: z.string().trim().min(1),
  usageMode: usageModeSchema.default("qa_source"),
  reviewStatus: reviewStatusSchema.default("approved"),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
});

const representativeKnowledgeBindingSchema = z.object({
  assetIds: z.array(z.string().trim().min(1)).max(100),
});

export const knowledgeAssetCreateSchema = z.object({
  kind: assetKindSchema,
  title: z.string().trim().min(1).max(180),
  visibility: assetVisibilitySchema.default("owner_only"),
  sourceUrl: z.string().trim().url().max(2_048).optional(),
  sourceText: z.string().max(MAX_SOURCE_CHARACTERS).optional(),
  originalFileName: z.string().trim().max(260).optional(),
  mimeType: z.string().trim().max(160).optional(),
  sizeBytes: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
  sourceObjectBucket: z.string().trim().min(1).max(180).optional(),
  sourceObjectKey: z.string().trim().min(1).max(1_024).optional(),
  sourceObjectEtag: z.string().trim().max(180).optional(),
  sourceObjectVersion: z.string().trim().max(300).optional(),
  sourceObjectChecksum: z.string().trim().length(64).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  representativeLinks: z.array(representativeLinkSchema).max(100).default([]),
  createdBy: z.string().trim().max(180).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const knowledgeAssetUpdateSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  visibility: assetVisibilitySchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  representativeLinks: z.array(representativeLinkSchema).max(100).optional(),
});

const knowledgeAssetSourceReplacementSchema = z.object({
  kind: fileAssetKindSchema,
  originalFileName: z.string().trim().min(1).max(260),
  mimeType: z.string().trim().max(160),
  sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  sourceObjectBucket: z.string().trim().min(1).max(180),
  sourceObjectKey: z.string().trim().min(1).max(1_024),
  sourceObjectEtag: z.string().trim().max(180).optional(),
  sourceObjectVersion: z.string().trim().max(300).optional(),
  sourceObjectChecksum: z.string().trim().length(64),
});

export type KnowledgeAssetCreateInput = z.input<typeof knowledgeAssetCreateSchema>;
export type KnowledgeAssetUpdateInput = z.input<typeof knowledgeAssetUpdateSchema>;
export type KnowledgeAssetSourceReplacementInput = z.input<typeof knowledgeAssetSourceReplacementSchema>;
export type KnowledgeFileConflictMatch = {
  id: string;
  title: string;
  originalFileName: string | null;
  sourceObjectChecksum: string | null;
  status: KnowledgeAssetRecord["status"];
  updatedAt: string;
};
export type KnowledgeFileConflicts = {
  exact: KnowledgeFileConflictMatch | null;
  sameName: KnowledgeFileConflictMatch | null;
};
export type KnowledgeAssetListFilters = {
  query?: string;
  status?: "processing" | "ready" | "failed" | "archived";
  kind?: z.infer<typeof assetKindSchema>;
  visibility?: z.infer<typeof assetVisibilitySchema>;
  tag?: string;
  representativeId?: string;
  includeArchived?: boolean;
};

export type KnowledgeRepresentativeOption = {
  id: string;
  slug: string;
  name: string;
};

export type RepresentativeKnowledgeBindingResult = {
  changedAssetIds: string[];
  selectedAssetIds: string[];
};

export type KnowledgeAssetRecord = {
  id: string;
  kind: z.infer<typeof assetKindSchema>;
  status: "processing" | "ready" | "failed" | "archived";
  visibility: z.infer<typeof assetVisibilitySchema>;
  title: string;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  sourceText: string | null;
  sourceObjectBucket: string | null;
  sourceObjectKey: string | null;
  sourceObjectEtag: string | null;
  sourceObjectVersion: string | null;
  sourceObjectChecksum: string | null;
  extractedText: string | null;
  summary: string | null;
  tags: string[];
  autoTags: string[];
  checksum: string | null;
  processingError: string | null;
  processingVersion: number;
  vectorBackend: string | null;
  vectorUri: string | null;
  vectorChunkCount: number;
  embeddingModel: string | null;
  indexedAt: string | null;
  processedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  representativeLinks: Array<{
    representativeId: string;
    representativeSlug: string;
    representativeName: string;
    usageMode: z.infer<typeof usageModeSchema>;
    reviewStatus: z.infer<typeof reviewStatusSchema>;
    enabled: boolean;
    priority: number;
  }>;
  processingLogs: Array<{
    id: string;
    stage: string;
    level: "info" | "warning" | "error";
    message: string;
    metadata: unknown;
    createdAt: string;
  }>;
};

type AssetWithRelations = Prisma.KnowledgeAssetGetPayload<{
  include: {
    representativeLinks: { include: { representative: true } };
    processingLogs: { orderBy: { createdAt: "asc" } };
  };
}>;

export class KnowledgeLibraryError extends Error {
  statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 422;

  constructor(message: string, statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 422 = 400) {
    super(message);
    this.name = "KnowledgeLibraryError";
    this.statusCode = statusCode;
  }
}

export async function listKnowledgeRepresentativeOptions(
  ownerId?: string | null,
): Promise<KnowledgeRepresentativeOption[]> {
  if (shouldUseDemoKnowledge(ownerId)) {
    return demoRepresentativeOptions();
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const rows = await prisma.representative.findMany({
    where: { ownerId: scopedOwnerId },
    select: { id: true, slug: true, displayName: true },
    orderBy: [{ updatedAt: "desc" }, { displayName: "asc" }],
  });
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.displayName }));
}

export async function resolveKnowledgeLibraryOwnerId(
  ownerId: string | null | undefined,
  representativeSlug: string | null | undefined,
): Promise<string | null> {
  const authenticatedOwnerId = ownerId?.trim();
  if (authenticatedOwnerId) return authenticatedOwnerId;
  if (!process.env.DATABASE_URL?.trim()) return null;
  const slug = representativeSlug?.trim();
  if (!slug) throw new KnowledgeLibraryError("Authentication required.", 401);
  const representative = await prisma.representative.findUnique({
    where: { slug },
    select: { ownerId: true },
  });
  if (!representative) throw new KnowledgeLibraryError("Representative not found.", 404);
  return representative.ownerId;
}

export async function listKnowledgeAssets(
  ownerId?: string | null,
  filters: KnowledgeAssetListFilters = {},
): Promise<KnowledgeAssetRecord[]> {
  if (shouldUseDemoKnowledge(ownerId)) {
    return filterDemoAssets(demoKnowledgeAssets, filters).map(cloneDemoAsset);
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const query = filters.query?.trim();
  const rows = await prisma.knowledgeAsset.findMany({
    where: {
      ownerId: scopedOwnerId,
      ...(!filters.includeArchived && !filters.status ? { status: { not: KnowledgeAssetStatus.ARCHIVED } } : {}),
      ...(filters.status ? { status: toAssetStatus(filters.status) } : {}),
      ...(filters.kind ? { kind: toAssetKind(filters.kind) } : {}),
      ...(filters.visibility ? { visibility: toVisibility(filters.visibility) } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.representativeId
        ? { representativeLinks: { some: { representativeId: filters.representativeId, enabled: true } } }
        : {}),
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: "insensitive" } },
              { originalFileName: { contains: query, mode: "insensitive" } },
              { sourceUrl: { contains: query, mode: "insensitive" } },
              { tags: { has: query } },
            ],
          }
        : {}),
    },
    include: knowledgeAssetInclude,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(serializeAsset);
}

export async function setRepresentativeKnowledgeAssetBindings(
  ownerId: string | null | undefined,
  representativeSlug: string,
  assetIds: unknown,
): Promise<RepresentativeKnowledgeBindingResult> {
  const parsed = representativeKnowledgeBindingSchema.parse({ assetIds });
  const selectedAssetIds = [...new Set(parsed.assetIds)];

  if (shouldUseDemoKnowledge(ownerId)) {
    if (representativeSlug !== demoRepresentative.slug) {
      throw new KnowledgeLibraryError("Representative not found.", 404);
    }
    const selected = new Set(selectedAssetIds);
    const existingIds = new Set(
      demoKnowledgeAssets
        .filter((asset) =>
          asset.representativeLinks.some(
            (link) => link.representativeId === demoRepresentative.id && link.enabled,
          ),
        )
        .map((asset) => asset.id),
    );
    const additions = selectedAssetIds.filter((assetId) => !existingIds.has(assetId));
    const selectedAssets = demoKnowledgeAssets.filter((asset) => selected.has(asset.id));
    if (selectedAssets.length !== selectedAssetIds.length) {
      throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
    }
    const unavailable = selectedAssets.find(
      (asset) => additions.includes(asset.id) && asset.status !== "ready",
    );
    if (unavailable) {
      throw new KnowledgeLibraryError(`知识“${unavailable.title}”尚未处理完成，暂时不能关联。`, 409);
    }

    const changedAssetIds: string[] = [];
    for (const asset of demoKnowledgeAssets) {
      const wasSelected = existingIds.has(asset.id);
      const isSelected = selected.has(asset.id);
      if (wasSelected === isSelected) continue;
      changedAssetIds.push(asset.id);
      asset.representativeLinks = asset.representativeLinks.filter(
        (link) => link.representativeId !== demoRepresentative.id,
      );
      if (isSelected) {
        asset.representativeLinks.push({
          representativeId: demoRepresentative.id,
          representativeSlug: demoRepresentative.slug,
          representativeName: demoRepresentative.name,
          usageMode: asset.visibility === "public_material" ? "both" : "qa_source",
          reviewStatus: "approved",
          enabled: true,
          priority: 50,
        });
        if (asset.visibility === "owner_only") asset.visibility = "selected_representatives";
      } else if (
        asset.visibility === "selected_representatives" &&
        !asset.representativeLinks.some((link) => link.enabled)
      ) {
        asset.visibility = "owner_only";
      }
      asset.updatedAt = new Date().toISOString();
      asset.processingLogs.push(
        demoLog(
          "representative_binding",
          "info",
          isSelected ? "知识已授权给数字代表，等待索引同步。" : "知识已从数字代表撤回，等待索引清理。",
        ),
      );
    }
    return { changedAssetIds, selectedAssetIds };
  }

  const scopedOwnerId = requireOwnerId(ownerId);
  const representative = await prisma.representative.findFirst({
    where: { slug: representativeSlug, ownerId: scopedOwnerId },
    select: { id: true, slug: true },
  });
  if (!representative) throw new KnowledgeLibraryError("Representative not found.", 404);

  const [selectedAssets, existingLinks] = await Promise.all([
    prisma.knowledgeAsset.findMany({
      where: {
        id: { in: selectedAssetIds },
        ownerId: scopedOwnerId,
        status: { not: KnowledgeAssetStatus.ARCHIVED },
      },
      select: { id: true, title: true, status: true, visibility: true },
    }),
    prisma.knowledgeAssetRepresentative.findMany({
      where: { representativeId: representative.id },
      select: { assetId: true, enabled: true },
    }),
  ]);
  if (selectedAssets.length !== selectedAssetIds.length) {
    throw new KnowledgeLibraryError("Knowledge asset not found or archived.", 404);
  }

  const existingEnabledIds = new Set(
    existingLinks.filter((link) => link.enabled).map((link) => link.assetId),
  );
  const additions = selectedAssets.filter((asset) => !existingEnabledIds.has(asset.id));
  const unavailable = additions.find((asset) => asset.status !== KnowledgeAssetStatus.READY);
  if (unavailable) {
    throw new KnowledgeLibraryError(`知识“${unavailable.title}”尚未处理完成，暂时不能关联。`, 409);
  }
  const selectedSet = new Set(selectedAssetIds);
  const removedAssetIds = [...existingEnabledIds].filter((assetId) => !selectedSet.has(assetId));
  const changedAssetIds = [
    ...additions.map((asset) => asset.id),
    ...removedAssetIds,
  ];

  await prisma.$transaction(async (tx) => {
    await tx.knowledgeAssetRepresentative.deleteMany({
      where: {
        representativeId: representative.id,
        ...(selectedAssetIds.length ? { assetId: { notIn: selectedAssetIds } } : {}),
      },
    });
    for (const asset of selectedAssets) {
      await tx.knowledgeAssetRepresentative.upsert({
        where: {
          assetId_representativeId: {
            assetId: asset.id,
            representativeId: representative.id,
          },
        },
        create: {
          assetId: asset.id,
          representativeId: representative.id,
          usageMode:
            asset.visibility === KnowledgeAssetVisibility.PUBLIC_MATERIAL
              ? KnowledgeAssetUsageMode.BOTH
              : KnowledgeAssetUsageMode.QA_SOURCE,
          reviewStatus: KnowledgeAssetReviewStatus.APPROVED,
          enabled: true,
          priority: 50,
        },
        update: {
          reviewStatus: KnowledgeAssetReviewStatus.APPROVED,
          enabled: true,
        },
      });
      if (asset.visibility === KnowledgeAssetVisibility.OWNER_ONLY) {
        await tx.knowledgeAsset.update({
          where: { id: asset.id },
          data: { visibility: KnowledgeAssetVisibility.SELECTED_REPRESENTATIVES },
        });
      }
    }
    for (const assetId of removedAssetIds) {
      const remainingLinks = await tx.knowledgeAssetRepresentative.count({
        where: { assetId, enabled: true },
      });
      if (!remainingLinks) {
        await tx.knowledgeAsset.updateMany({
          where: {
            id: assetId,
            visibility: KnowledgeAssetVisibility.SELECTED_REPRESENTATIVES,
          },
          data: { visibility: KnowledgeAssetVisibility.OWNER_ONLY },
        });
      }
    }
    if (changedAssetIds.length) {
      await tx.knowledgeProcessingLog.createMany({
        data: changedAssetIds.map((assetId) => ({
          assetId,
          stage: "representative_binding",
          message: selectedSet.has(assetId)
            ? "知识已授权给数字代表，等待索引同步。"
            : "知识已从数字代表撤回，等待索引清理。",
        })),
      });
    }
  });

  return { changedAssetIds, selectedAssetIds };
}

export async function getKnowledgeAsset(
  ownerId: string | null | undefined,
  assetId: string,
): Promise<KnowledgeAssetRecord> {
  if (shouldUseDemoKnowledge(ownerId)) {
    const asset = demoKnowledgeAssets.find((item) => item.id === assetId);
    if (!asset) throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
    return cloneDemoAsset(asset);
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const row = await prisma.knowledgeAsset.findFirst({
    where: { id: assetId, ownerId: scopedOwnerId },
    include: knowledgeAssetInclude,
  });
  if (!row) throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
  return serializeAsset(row);
}

export async function queueKnowledgeAssetProcessing(
  ownerId: string | null | undefined,
  assetId: string,
): Promise<{ asset: KnowledgeAssetRecord; queued: boolean }> {
  if (shouldUseDemoKnowledge(ownerId)) {
    const asset = requireDemoAsset(assetId);
    if (asset.status === "archived") {
      throw new KnowledgeLibraryError(
        "Archived knowledge must be restored before reprocessing.",
        409,
      );
    }
    if (asset.status === "processing") {
      return { asset: cloneDemoAsset(asset), queued: false };
    }
    asset.status = "processing";
    asset.processingError = null;
    asset.updatedAt = new Date().toISOString();
    asset.processingLogs.push(
      demoLog("queued", "info", "知识已加入后台重新处理队列。"),
    );
    return { asset: cloneDemoAsset(asset), queued: true };
  }

  const scopedOwnerId = requireOwnerId(ownerId);
  const existing = await requireDatabaseAsset(scopedOwnerId, assetId);
  if (existing.status === KnowledgeAssetStatus.ARCHIVED) {
    throw new KnowledgeLibraryError(
      "Archived knowledge must be restored before reprocessing.",
      409,
    );
  }
  const transition = await prisma.knowledgeAsset.updateMany({
    where: {
      id: assetId,
      ownerId: scopedOwnerId,
      status: {
        notIn: [KnowledgeAssetStatus.PROCESSING, KnowledgeAssetStatus.ARCHIVED],
      },
    },
    data: {
      status: KnowledgeAssetStatus.PROCESSING,
      processingError: null,
    },
  });
  if (transition.count > 0) {
    await prisma.knowledgeProcessingLog.create({
      data: {
        assetId,
        stage: "queued",
        message: "知识已加入后台重新处理队列。",
      },
    });
  }
  const asset = await getKnowledgeAsset(scopedOwnerId, assetId);
  if (asset.status === "archived") {
    throw new KnowledgeLibraryError(
      "Archived knowledge must be restored before reprocessing.",
      409,
    );
  }
  return { asset, queued: transition.count > 0 };
}

export async function findKnowledgeFileConflicts(
  ownerId: string | null | undefined,
  input: { fileName: string; checksum: string },
): Promise<KnowledgeFileConflicts> {
  const fileName = z.string().trim().min(1).max(260).parse(input.fileName);
  const checksum = z.string().trim().length(64).parse(input.checksum);
  if (shouldUseDemoKnowledge(ownerId)) {
    const candidates = demoKnowledgeAssets
      .filter((asset) => asset.status !== "archived")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      exact: toConflictMatch(candidates.find((asset) => asset.sourceObjectChecksum === checksum) ?? null),
      sameName: toConflictMatch(candidates.find((asset) => sameFileName(asset.originalFileName, fileName)) ?? null),
    };
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const candidates = await prisma.knowledgeAsset.findMany({
    where: {
      ownerId: scopedOwnerId,
      status: { not: KnowledgeAssetStatus.ARCHIVED },
      OR: [
        { sourceObjectChecksum: checksum },
        { originalFileName: { equals: fileName, mode: "insensitive" } },
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      originalFileName: true,
      sourceObjectChecksum: true,
      status: true,
      updatedAt: true,
    },
  });
  return {
    exact: toConflictMatch(candidates.find((asset) => asset.sourceObjectChecksum === checksum) ?? null),
    sameName: toConflictMatch(candidates.find((asset) => sameFileName(asset.originalFileName, fileName)) ?? null),
  };
}

export async function resolveUniqueKnowledgeAssetTitle(
  ownerId: string | null | undefined,
  requestedTitle: string,
): Promise<string> {
  const baseTitle = z.string().trim().min(1).max(180).parse(requestedTitle);
  const titles = shouldUseDemoKnowledge(ownerId)
    ? demoKnowledgeAssets.map((asset) => asset.title)
    : (await prisma.knowledgeAsset.findMany({
        where: { ownerId: requireOwnerId(ownerId), title: { startsWith: baseTitle, mode: "insensitive" } },
        select: { title: true },
      })).map((asset) => asset.title);
  const occupied = new Set(titles.map((title) => title.trim().toLocaleLowerCase()));
  if (!occupied.has(baseTitle.toLocaleLowerCase())) return baseTitle;
  for (let copy = 2; copy < 10_000; copy += 1) {
    const suffix = ` (${copy})`;
    const candidate = `${baseTitle.slice(0, Math.max(1, 180 - suffix.length)).trimEnd()}${suffix}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new KnowledgeLibraryError("无法为同名知识生成唯一标题。", 409);
}

export async function replaceKnowledgeAssetSource(
  ownerId: string | null | undefined,
  assetId: string,
  input: KnowledgeAssetSourceReplacementInput,
): Promise<KnowledgeAssetRecord> {
  const parsed = knowledgeAssetSourceReplacementSchema.parse(input);
  if (shouldUseDemoKnowledge(ownerId)) {
    const asset = requireDemoAsset(assetId);
    if (asset.status === "archived") throw new KnowledgeLibraryError("不能覆盖已归档的知识。", 409);
    const previousObject = asset.sourceObjectBucket && asset.sourceObjectKey
      ? { bucket: asset.sourceObjectBucket, objectKey: asset.sourceObjectKey }
      : null;
    if (asset.vectorUri) {
      await removeKnowledgeTextIndex({
        ownerId: "demo",
        assetId,
        representativeSlugs: asset.representativeLinks.filter((link) => link.enabled).map((link) => link.representativeSlug),
      });
    }
    assignReplacementSource(asset, parsed);
    asset.processingLogs.push(demoLog("source_replace", "info", "源文件已安全替换，等待重新提取并构建向量索引。"));
    if (previousObject && previousObject.objectKey !== parsed.sourceObjectKey) {
      await deleteKnowledgeSource(previousObject).catch(() => undefined);
    }
    return cloneDemoAsset(asset);
  }

  const scopedOwnerId = requireOwnerId(ownerId);
  if (!parsed.sourceObjectKey.startsWith(buildKnowledgeOwnerObjectPrefix(scopedOwnerId))) {
    throw new KnowledgeLibraryError("不能引用其他工作区的知识对象。", 403);
  }
  const asset = await requireDatabaseAsset(scopedOwnerId, assetId);
  if (asset.status === KnowledgeAssetStatus.ARCHIVED) {
    throw new KnowledgeLibraryError("不能覆盖已归档的知识。", 409);
  }
  const previousObject = asset.sourceObjectBucket && asset.sourceObjectKey
    ? { bucket: asset.sourceObjectBucket, objectKey: asset.sourceObjectKey }
    : null;
  if (asset.vectorUri) {
    const links = await prisma.knowledgeAssetRepresentative.findMany({
      where: { assetId, enabled: true },
      include: { representative: { select: { slug: true } } },
    });
    await removeKnowledgeTextIndex({
      ownerId: scopedOwnerId,
      assetId,
      representativeSlugs: links.map((link) => link.representative.slug),
      required: asset.vectorBackend === "openviking",
    });
  }
  try {
    await prisma.knowledgeAsset.update({
      where: { id: assetId },
      data: {
        kind: toAssetKind(parsed.kind),
        status: KnowledgeAssetStatus.PROCESSING,
        originalFileName: parsed.originalFileName,
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        sourceUrl: null,
        sourceText: null,
        sourceObjectBucket: parsed.sourceObjectBucket,
        sourceObjectKey: parsed.sourceObjectKey,
        sourceObjectEtag: parsed.sourceObjectEtag ?? null,
        sourceObjectVersion: parsed.sourceObjectVersion ?? null,
        sourceObjectChecksum: parsed.sourceObjectChecksum,
        extractedText: null,
        summary: null,
        autoTags: [],
        checksum: null,
        processingError: null,
        vectorBackend: null,
        vectorUri: null,
        vectorChunkCount: 0,
        embeddingModel: null,
        indexedAt: null,
        processedAt: null,
        processingLogs: {
          create: { stage: "source_replace", message: "源文件已安全替换，等待重新提取并构建向量索引。" },
        },
      },
    });
  } catch (error) {
    await processKnowledgeAsset(scopedOwnerId, assetId).catch(() => undefined);
    throw error;
  }
  if (previousObject && previousObject.objectKey !== parsed.sourceObjectKey) {
    await deleteKnowledgeSource(previousObject).catch(async () => {
      await prisma.knowledgeProcessingLog.create({
        data: {
          assetId,
          stage: "source_cleanup",
          level: KnowledgeProcessingLogLevel.WARNING,
          message: "新源文件已生效，但旧对象清理失败，等待后台回收。",
        },
      }).catch(() => undefined);
    });
  }
  return getKnowledgeAsset(scopedOwnerId, assetId);
}

export async function createKnowledgeAsset(
  ownerId: string | null | undefined,
  input: KnowledgeAssetCreateInput,
  options: { processingMode?: "inline" | "deferred" } = {},
): Promise<KnowledgeAssetRecord> {
  const parsed = knowledgeAssetCreateSchema.parse(input);
  validateCreateSource(parsed);
  if (shouldUseDemoKnowledge(ownerId)) {
    validateDemoLinks(parsed.representativeLinks);
    const now = new Date().toISOString();
    const asset: KnowledgeAssetRecord = {
      id: `knowledge_${randomUUID()}`,
      kind: parsed.kind,
      status: "processing",
      visibility: parsed.visibility,
      title: parsed.title,
      originalFileName: parsed.originalFileName ?? null,
      mimeType: parsed.mimeType ?? null,
      sizeBytes: parsed.sizeBytes ?? null,
      sourceUrl: parsed.sourceUrl ?? null,
      sourceText: parsed.sourceText ?? null,
      sourceObjectBucket: parsed.sourceObjectBucket ?? null,
      sourceObjectKey: parsed.sourceObjectKey ?? null,
      sourceObjectEtag: parsed.sourceObjectEtag ?? null,
      sourceObjectVersion: parsed.sourceObjectVersion ?? null,
      sourceObjectChecksum: parsed.sourceObjectChecksum ?? null,
      extractedText: null,
      summary: null,
      tags: normalizeTags(parsed.tags),
      autoTags: [],
      checksum: null,
      processingError: null,
      processingVersion: 0,
      vectorBackend: null,
      vectorUri: null,
      vectorChunkCount: 0,
      embeddingModel: null,
      indexedAt: null,
      processedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      representativeLinks: parsed.representativeLinks.map(toDemoLink),
      processingLogs: [demoLog("queued", "info", "知识资产已创建，等待内容处理。")],
    };
    demoKnowledgeAssets.unshift(asset);
    return options.processingMode === "deferred" ? cloneDemoAsset(asset) : processDemoKnowledgeAsset(asset);
  }

  const scopedOwnerId = requireOwnerId(ownerId);
  if (parsed.sourceObjectKey && !parsed.sourceObjectKey.startsWith(buildKnowledgeOwnerObjectPrefix(scopedOwnerId))) {
    throw new KnowledgeLibraryError("不能引用其他工作区的知识对象。", 403);
  }
  await assertRepresentativeLinksBelongToOwner(scopedOwnerId, parsed.representativeLinks);
  const created = await prisma.knowledgeAsset.create({
    data: {
      ownerId: scopedOwnerId,
      kind: toAssetKind(parsed.kind),
      status: KnowledgeAssetStatus.PROCESSING,
      visibility: toVisibility(parsed.visibility),
      title: parsed.title,
      ...(parsed.originalFileName ? { originalFileName: parsed.originalFileName } : {}),
      ...(parsed.mimeType ? { mimeType: parsed.mimeType } : {}),
      ...(parsed.sizeBytes !== undefined ? { sizeBytes: parsed.sizeBytes } : {}),
      ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
      ...(parsed.sourceText ? { sourceText: parsed.sourceText } : {}),
      ...(parsed.sourceObjectBucket ? { sourceObjectBucket: parsed.sourceObjectBucket } : {}),
      ...(parsed.sourceObjectKey ? { sourceObjectKey: parsed.sourceObjectKey } : {}),
      ...(parsed.sourceObjectEtag ? { sourceObjectEtag: parsed.sourceObjectEtag } : {}),
      ...(parsed.sourceObjectVersion ? { sourceObjectVersion: parsed.sourceObjectVersion } : {}),
      ...(parsed.sourceObjectChecksum ? { sourceObjectChecksum: parsed.sourceObjectChecksum } : {}),
      tags: normalizeTags(parsed.tags),
      processingVersion: 0,
      ...(parsed.createdBy ? { createdBy: parsed.createdBy } : {}),
      ...(parsed.metadata ? { metadata: parsed.metadata as Prisma.InputJsonValue } : {}),
      representativeLinks: {
        create: parsed.representativeLinks.map((link) => ({
          representativeId: link.representativeId,
          usageMode: toUsageMode(link.usageMode),
          reviewStatus: toReviewStatus(link.reviewStatus),
          enabled: link.enabled,
          priority: link.priority,
        })),
      },
      processingLogs: {
        create: { stage: "queued", message: "知识资产已创建，等待内容处理。" },
      },
    },
    select: { id: true },
  });
  return options.processingMode === "deferred"
    ? getKnowledgeAsset(scopedOwnerId, created.id)
    : processKnowledgeAsset(scopedOwnerId, created.id);
}

export async function updateKnowledgeAsset(
  ownerId: string | null | undefined,
  assetId: string,
  input: KnowledgeAssetUpdateInput,
): Promise<KnowledgeAssetRecord> {
  const parsed = knowledgeAssetUpdateSchema.parse(input);
  if (shouldUseDemoKnowledge(ownerId)) {
    const asset = requireDemoAsset(assetId);
    const previousRepresentativeSlugs = asset.representativeLinks
      .filter((link) => link.enabled)
      .map((link) => link.representativeSlug);
    const nextVisibility = parsed.visibility ?? asset.visibility;
    const nextLinks = parsed.representativeLinks ?? asset.representativeLinks;
    if (nextVisibility === "selected_representatives" && !nextLinks.some((link) => link.enabled)) {
      throw new KnowledgeLibraryError("选择“指定代表”权限时，至少要关联一个已启用的代表。", 422);
    }
    if (parsed.representativeLinks) {
      validateDemoLinks(parsed.representativeLinks);
      asset.representativeLinks = parsed.representativeLinks.map(toDemoLink);
    }
    if (parsed.title) asset.title = parsed.title;
    if (parsed.visibility) asset.visibility = parsed.visibility;
    if (parsed.tags) asset.tags = normalizeTags(parsed.tags);
    asset.updatedAt = new Date().toISOString();
    asset.processingLogs.push(demoLog("configuration", "info", "知识标题、标签或权限配置已更新。"));
    return parsed.title || parsed.representativeLinks
      ? processDemoKnowledgeAsset(asset, { staleRepresentativeSlugs: previousRepresentativeSlugs })
      : cloneDemoAsset(asset);
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const existingAsset = await requireDatabaseAsset(scopedOwnerId, assetId);
  const previousLinks = parsed.representativeLinks
    ? await prisma.knowledgeAssetRepresentative.findMany({
        where: { assetId, enabled: true },
        include: { representative: { select: { slug: true } } },
      })
    : [];
  const nextVisibility = parsed.visibility ? toVisibility(parsed.visibility) : existingAsset.visibility;
  if (nextVisibility === KnowledgeAssetVisibility.SELECTED_REPRESENTATIVES) {
    const enabledLinkCount = parsed.representativeLinks
      ? parsed.representativeLinks.filter((link) => link.enabled).length
      : await prisma.knowledgeAssetRepresentative.count({ where: { assetId, enabled: true } });
    if (!enabledLinkCount) {
      throw new KnowledgeLibraryError("选择“指定代表”权限时，至少要关联一个已启用的代表。", 422);
    }
  }
  if (parsed.representativeLinks) {
    await assertRepresentativeLinksBelongToOwner(scopedOwnerId, parsed.representativeLinks);
  }
  await prisma.$transaction(async (tx) => {
    await tx.knowledgeAsset.update({
      where: { id: assetId },
      data: {
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.visibility ? { visibility: toVisibility(parsed.visibility) } : {}),
        ...(parsed.tags ? { tags: normalizeTags(parsed.tags) } : {}),
      },
    });
    if (parsed.representativeLinks) {
      await tx.knowledgeAssetRepresentative.deleteMany({ where: { assetId } });
      if (parsed.representativeLinks.length) {
        await tx.knowledgeAssetRepresentative.createMany({
          data: parsed.representativeLinks.map((link) => ({
            assetId,
            representativeId: link.representativeId,
            usageMode: toUsageMode(link.usageMode),
            reviewStatus: toReviewStatus(link.reviewStatus),
            enabled: link.enabled,
            priority: link.priority,
          })),
        });
      }
    }
    await tx.knowledgeProcessingLog.create({
      data: { assetId, stage: "configuration", message: "知识标题、标签或权限配置已更新。" },
    });
  });
  if (parsed.title || parsed.representativeLinks) {
    return processKnowledgeAsset(scopedOwnerId, assetId, {
      staleRepresentativeSlugs: previousLinks.map((link) => link.representative.slug),
    });
  }
  return getKnowledgeAsset(scopedOwnerId, assetId);
}

export async function processKnowledgeAsset(
  ownerId: string | null | undefined,
  assetId: string,
  options: { staleRepresentativeSlugs?: string[] } = {},
): Promise<KnowledgeAssetRecord> {
  if (shouldUseDemoKnowledge(ownerId)) {
    return processDemoKnowledgeAsset(requireDemoAsset(assetId), options);
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const asset = await requireDatabaseAsset(scopedOwnerId, assetId);
  if (asset.status === KnowledgeAssetStatus.ARCHIVED) {
    throw new KnowledgeLibraryError("Archived knowledge must be restored before reprocessing.", 409);
  }
  await prisma.knowledgeAsset.update({
    where: { id: assetId },
    data: {
      status: KnowledgeAssetStatus.PROCESSING,
      processingError: null,
      processingVersion: { increment: 1 },
      processingLogs: { create: { stage: "extract", message: "开始提取并规范化知识内容。" } },
    },
  });
  try {
    const extracted = await resolveAssetText({
      kind: fromAssetKind(asset.kind),
      sourceText: asset.sourceText,
      sourceUrl: asset.sourceUrl,
      sourceObjectBucket: asset.sourceObjectBucket,
      sourceObjectKey: asset.sourceObjectKey,
      originalFileName: asset.originalFileName,
      mimeType: asset.mimeType,
    });
    const normalized = normalizeExtractedText(extracted);
    if (normalized.length < 20) {
      throw new KnowledgeLibraryError("提取内容过短，请提供至少 20 个字符的有效正文。", 422);
    }
    const summary = buildKnowledgeSummary(normalized);
    const autoTags = inferKnowledgeTags(normalized, asset.title);
    const checksum = createHash("sha256").update(normalized).digest("hex");
    const links = await prisma.knowledgeAssetRepresentative.findMany({
      where: { assetId, enabled: true, reviewStatus: KnowledgeAssetReviewStatus.APPROVED },
      include: { representative: { select: { slug: true } } },
    });
    await prisma.knowledgeAsset.update({
      where: { id: assetId },
      data: {
        extractedText: normalized,
        summary,
        autoTags,
        checksum,
        processingLogs: {
          create: {
            stage: "vectorize",
            message: "正文提取结果已保存，正在写入 OpenViking 向量索引。",
          },
        },
      },
    });
    const vector = await indexKnowledgeText({
      ownerId: scopedOwnerId,
      assetId,
      title: asset.title,
      text: normalized,
      checksum,
      representativeSlugs: links.map((link) => link.representative.slug),
      ...(options.staleRepresentativeSlugs
        ? { staleRepresentativeSlugs: options.staleRepresentativeSlugs }
        : {}),
    });
    await prisma.knowledgeAsset.update({
      where: { id: assetId },
      data: {
        status: KnowledgeAssetStatus.READY,
        extractedText: normalized,
        summary,
        autoTags,
        checksum,
        vectorBackend: vector.backend,
        vectorUri: vector.uri,
        vectorChunkCount: vector.chunkCount,
        embeddingModel: vector.embeddingModel,
        indexedAt: vector.indexedAt,
        processingError: null,
        processedAt: new Date(),
        processingLogs: {
          createMany: {
            data: [
              { stage: "index", message: `已规范化 ${normalized.length.toLocaleString()} 个字符，并生成 ${vector.chunkCount} 个检索分块。` },
              { stage: "complete", message: "原始内容、解析正文和向量索引均已就绪，可供已授权代表使用。" },
            ],
          },
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识内容处理失败。";
    await prisma.knowledgeAsset.update({
      where: { id: assetId },
      data: {
        status: KnowledgeAssetStatus.FAILED,
        processingError: message,
        vectorBackend: null,
        vectorUri: null,
        vectorChunkCount: 0,
        embeddingModel: null,
        indexedAt: null,
        processingLogs: {
          create: { stage: "failed", level: KnowledgeProcessingLogLevel.ERROR, message },
        },
      },
    });
  }
  return getKnowledgeAsset(scopedOwnerId, assetId);
}

export async function archiveKnowledgeAsset(
  ownerId: string | null | undefined,
  assetId: string,
  archived: boolean,
): Promise<KnowledgeAssetRecord> {
  if (shouldUseDemoKnowledge(ownerId)) {
    const asset = requireDemoAsset(assetId);
    if (archived) {
      await removeKnowledgeTextIndex({
        ownerId: "demo",
        assetId,
        representativeSlugs: asset.representativeLinks.filter((link) => link.enabled).map((link) => link.representativeSlug),
      });
      asset.vectorBackend = null;
      asset.vectorUri = null;
      asset.vectorChunkCount = 0;
      asset.embeddingModel = null;
      asset.indexedAt = null;
    }
    asset.status = archived ? "archived" : "failed";
    asset.archivedAt = archived ? new Date().toISOString() : null;
    asset.updatedAt = new Date().toISOString();
    asset.processingLogs.push(demoLog("archive", "info", archived ? "知识资产已归档。" : "知识资产已恢复。"));
    return archived ? cloneDemoAsset(asset) : processDemoKnowledgeAsset(asset);
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const asset = await requireDatabaseAsset(scopedOwnerId, assetId);
  const links = await prisma.knowledgeAssetRepresentative.findMany({
    where: { assetId, enabled: true },
    include: { representative: { select: { slug: true } } },
  });
  if (archived && asset.vectorUri) {
    await removeKnowledgeTextIndex({
      ownerId: scopedOwnerId,
      assetId,
      representativeSlugs: links.map((link) => link.representative.slug),
      required: asset.vectorBackend === "openviking" && Boolean(asset.vectorUri),
    });
  }
  const nextStatus = archived ? KnowledgeAssetStatus.ARCHIVED : KnowledgeAssetStatus.FAILED;
  await prisma.knowledgeAsset.update({
    where: { id: assetId },
    data: {
      status: nextStatus,
      archivedAt: archived ? new Date() : null,
      ...(!archived ? { processingError: null } : {}),
      ...(archived
        ? {
            vectorBackend: null,
            vectorUri: null,
            vectorChunkCount: 0,
            embeddingModel: null,
            indexedAt: null,
          }
        : {}),
      processingLogs: {
        create: { stage: "archive", message: archived ? "知识资产已归档。" : "知识资产已恢复。" },
      },
    },
  });
  return archived
    ? getKnowledgeAsset(scopedOwnerId, assetId)
    : processKnowledgeAsset(scopedOwnerId, assetId);
}

export async function deleteKnowledgeAsset(
  ownerId: string | null | undefined,
  assetId: string,
): Promise<void> {
  if (shouldUseDemoKnowledge(ownerId)) {
    const index = demoKnowledgeAssets.findIndex((asset) => asset.id === assetId);
    if (index < 0) throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
    if (demoKnowledgeAssets[index]?.status !== "archived") {
      throw new KnowledgeLibraryError("Archive the knowledge asset before deleting it permanently.", 409);
    }
    const asset = demoKnowledgeAssets[index]!;
    await removeKnowledgeTextIndex({
      ownerId: "demo",
      assetId,
      representativeSlugs: asset.representativeLinks.filter((link) => link.enabled).map((link) => link.representativeSlug),
    });
    if (asset.sourceObjectBucket && asset.sourceObjectKey) {
      await deleteKnowledgeSource({ bucket: asset.sourceObjectBucket, objectKey: asset.sourceObjectKey });
    }
    demoKnowledgeAssets.splice(index, 1);
    return;
  }
  const scopedOwnerId = requireOwnerId(ownerId);
  const asset = await requireDatabaseAsset(scopedOwnerId, assetId);
  if (asset.status !== KnowledgeAssetStatus.ARCHIVED) {
    throw new KnowledgeLibraryError("Archive the knowledge asset before deleting it permanently.", 409);
  }
  const links = await prisma.knowledgeAssetRepresentative.findMany({
    where: { assetId, enabled: true },
    include: { representative: { select: { slug: true } } },
  });
  if (asset.vectorUri) {
    await removeKnowledgeTextIndex({
      ownerId: scopedOwnerId,
      assetId,
      representativeSlugs: links.map((link) => link.representative.slug),
      required: asset.vectorBackend === "openviking",
    });
  }
  if (asset.sourceObjectBucket && asset.sourceObjectKey) {
    await deleteKnowledgeSource({ bucket: asset.sourceObjectBucket, objectKey: asset.sourceObjectKey });
  }
  await prisma.knowledgeAsset.delete({ where: { id: assetId } });
}

export async function extractKnowledgeFile(input: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}): Promise<{ kind: z.infer<typeof assetKindSchema>; text: string }> {
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new KnowledgeLibraryError("文件不能超过 15 MB。", 413);
  }
  const kind = detectKnowledgeFileKind(input.fileName);
  const extension = input.fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "docx") {
    const zip = await JSZip.loadAsync(input.bytes);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml) throw new KnowledgeLibraryError("DOCX 文件缺少正文内容。", 422);
    return { kind: "docx", text: decodeXmlText(documentXml) };
  }
  if (extension === "pdf") {
    const parser = new PDFParse({ data: input.bytes });
    let normalized = "";
    try {
      const result = await parser.getText();
      normalized = normalizeExtractedText(result.text);
    } catch (error) {
      throw new KnowledgeLibraryError(
        error instanceof Error ? `PDF 解析失败：${error.message}` : "PDF 解析失败。",
        422,
      );
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    if (normalized.length < 20) {
      throw new KnowledgeLibraryError("该 PDF 未提取到足够文本，可能是扫描件；请启用 OCR 后重试，或转换为可搜索 PDF/DOCX/TXT。", 422);
    }
    return { kind: "pdf", text: normalized };
  }
  if (["txt", "md", "markdown"].includes(extension)) {
    return {
      kind: extension === "txt" ? "txt" : "markdown",
      text: new TextDecoder("utf-8", { fatal: false }).decode(input.bytes),
    };
  }
  throw new KnowledgeLibraryError(`不支持 ${kind} 类型的知识文件。`, 422);
}

export function detectKnowledgeFileKind(fileName: string): "pdf" | "docx" | "txt" | "markdown" {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf" || extension === "docx" || extension === "txt") return extension;
  if (extension === "md" || extension === "markdown") return "markdown";
  throw new KnowledgeLibraryError("仅支持 PDF、DOCX、TXT 和 Markdown 文件。", 422);
}

export function buildKnowledgeSummary(text: string): string {
  const normalized = normalizeExtractedText(text);
  if (normalized.length <= 280) return normalized;
  const sentences = normalized.split(/(?<=[。！？.!?])\s+/).filter(Boolean);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length + sentence.length > 320) break;
    summary += `${summary ? " " : ""}${sentence}`;
  }
  return summary.length >= 80 ? summary : `${normalized.slice(0, 280).trim()}…`;
}

export function inferKnowledgeTags(text: string, title = ""): string[] {
  const content = `${title} ${text}`.toLowerCase();
  const dictionary: Array<[string, RegExp]> = [
    ["产品", /产品|product|feature|功能/],
    ["价格", /价格|报价|费用|pricing|price|plan/],
    ["服务", /服务|咨询|交付|service|consult/],
    ["FAQ", /faq|常见问题|问答/],
    ["政策", /政策|规则|退款|隐私|policy|refund|privacy/],
    ["品牌", /品牌|语气|使命|愿景|brand|mission|vision/],
    ["案例", /案例|客户|成果|case study|customer/],
    ["团队", /团队|创始人|成员|team|founder/],
    ["技术", /技术|api|架构|部署|technology|architecture/],
  ];
  return dictionary.filter(([, pattern]) => pattern.test(content)).map(([tag]) => tag).slice(0, 6);
}

function validateCreateSource(input: z.output<typeof knowledgeAssetCreateSchema>) {
  if (input.kind === "url" && !input.sourceUrl) {
    throw new KnowledgeLibraryError("URL 知识必须提供有效网址。", 422);
  }
  const hasStoredFile = Boolean(input.sourceObjectBucket && input.sourceObjectKey);
  if (input.kind !== "url" && !input.sourceText?.trim() && !hasStoredFile) {
    throw new KnowledgeLibraryError("知识正文不能为空。", 422);
  }
  if (Boolean(input.sourceObjectBucket) !== Boolean(input.sourceObjectKey)) {
    throw new KnowledgeLibraryError("对象存储 bucket 和 object key 必须同时提供。", 422);
  }
  if (input.visibility === "selected_representatives" && !input.representativeLinks.length) {
    throw new KnowledgeLibraryError("选择“指定代表”权限时，至少要关联一个代表。", 422);
  }
}

async function resolveAssetText(input: {
  kind: z.infer<typeof assetKindSchema>;
  sourceText: string | null;
  sourceUrl: string | null;
  sourceObjectBucket?: string | null;
  sourceObjectKey?: string | null;
  originalFileName?: string | null;
  mimeType?: string | null;
}): Promise<string> {
  if (input.sourceObjectBucket && input.sourceObjectKey) {
    if (!input.originalFileName) throw new KnowledgeLibraryError("知识文件缺少原始文件名。", 422);
    const object = await readKnowledgeSource({
      bucket: input.sourceObjectBucket,
      objectKey: input.sourceObjectKey,
    });
    const extraction = await extractKnowledgeFile({
      bytes: object.bytes,
      fileName: input.originalFileName,
      ...(input.mimeType ?? object.contentType
        ? { mimeType: (input.mimeType ?? object.contentType)! }
        : {}),
    });
    return extraction.text;
  }
  if (input.kind !== "url") return input.sourceText ?? "";
  if (!input.sourceUrl) throw new KnowledgeLibraryError("URL 知识缺少来源网址。", 422);
  return fetchKnowledgeUrl(input.sourceUrl);
}

async function fetchKnowledgeUrl(rawUrl: string): Promise<string> {
  const url = await assertSafePublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "User-Agent": "Delegate-Knowledge-Ingest/1.0", Accept: "text/html,text/plain" },
    });
    if (!response.ok) throw new KnowledgeLibraryError(`无法读取网址（HTTP ${response.status}）。`, 422);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_FILE_BYTES) throw new KnowledgeLibraryError("网址内容超过 15 MB 限制。", 413);
    const body = await response.text();
    if (body.length > MAX_SOURCE_CHARACTERS * 2) {
      throw new KnowledgeLibraryError("网址正文过长，请拆分后导入。", 413);
    }
    return htmlToText(body);
  } catch (error) {
    if (error instanceof KnowledgeLibraryError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new KnowledgeLibraryError("读取网址超时，请稍后重试。", 422);
    }
    throw new KnowledgeLibraryError(error instanceof Error ? `无法读取网址：${error.message}` : "无法读取网址。", 422);
  } finally {
    clearTimeout(timer);
  }
}

async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new KnowledgeLibraryError("网址格式无效。", 422);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new KnowledgeLibraryError("仅支持不包含账号信息的 HTTP/HTTPS 公网网址。", 422);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || isPrivateAddress(hostname)) {
    throw new KnowledgeLibraryError("不能导入本机或私有网络地址。", 422);
  }
  try {
    const resolved = await lookup(hostname, { all: true });
    if (!resolved.length || resolved.some((item) => isPrivateAddress(item.address))) {
      throw new KnowledgeLibraryError("不能导入解析到私有网络的地址。", 422);
    }
  } catch (error) {
    if (error instanceof KnowledgeLibraryError) throw error;
    throw new KnowledgeLibraryError("网址域名无法解析。", 422);
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    (parts[0]! >= 224);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/?\s*>/g, "\t")
    .replace(/<w:br\/?\s*>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_SOURCE_CHARACTERS);
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function sameFileName(left: string | null, right: string): boolean {
  return left?.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function toConflictMatch(asset: {
  id: string;
  title: string;
  originalFileName: string | null;
  sourceObjectChecksum: string | null;
  status: KnowledgeAssetStatus | KnowledgeAssetRecord["status"];
  updatedAt: Date | string;
} | null): KnowledgeFileConflictMatch | null {
  if (!asset) return null;
  return {
    id: asset.id,
    title: asset.title,
    originalFileName: asset.originalFileName,
    sourceObjectChecksum: asset.sourceObjectChecksum,
    status: String(asset.status).toLowerCase() as KnowledgeAssetRecord["status"],
    updatedAt: asset.updatedAt instanceof Date ? asset.updatedAt.toISOString() : asset.updatedAt,
  };
}

function assignReplacementSource(
  asset: KnowledgeAssetRecord,
  input: z.output<typeof knowledgeAssetSourceReplacementSchema>,
) {
  asset.kind = input.kind;
  asset.status = "processing";
  asset.originalFileName = input.originalFileName;
  asset.mimeType = input.mimeType;
  asset.sizeBytes = input.sizeBytes;
  asset.sourceUrl = null;
  asset.sourceText = null;
  asset.sourceObjectBucket = input.sourceObjectBucket;
  asset.sourceObjectKey = input.sourceObjectKey;
  asset.sourceObjectEtag = input.sourceObjectEtag ?? null;
  asset.sourceObjectVersion = input.sourceObjectVersion ?? null;
  asset.sourceObjectChecksum = input.sourceObjectChecksum;
  asset.extractedText = null;
  asset.summary = null;
  asset.autoTags = [];
  asset.checksum = null;
  asset.processingError = null;
  asset.vectorBackend = null;
  asset.vectorUri = null;
  asset.vectorChunkCount = 0;
  asset.embeddingModel = null;
  asset.indexedAt = null;
  asset.processedAt = null;
  asset.archivedAt = null;
  asset.updatedAt = new Date().toISOString();
}

async function assertRepresentativeLinksBelongToOwner(
  ownerId: string,
  links: Array<z.output<typeof representativeLinkSchema>>,
) {
  const ids = [...new Set(links.map((link) => link.representativeId))];
  if (ids.length !== links.length) throw new KnowledgeLibraryError("同一个代表不能重复关联。", 422);
  if (!ids.length) return;
  const count = await prisma.representative.count({ where: { id: { in: ids }, ownerId } });
  if (count !== ids.length) throw new KnowledgeLibraryError("包含无权访问的代表。", 403);
}

async function requireDatabaseAsset(ownerId: string, assetId: string) {
  const asset = await prisma.knowledgeAsset.findFirst({ where: { id: assetId, ownerId } });
  if (!asset) throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
  return asset;
}

function requireOwnerId(ownerId?: string | null): string {
  const normalized = ownerId?.trim();
  if (!normalized) throw new KnowledgeLibraryError("Authentication required.", 401);
  return normalized;
}

const knowledgeAssetInclude = {
  representativeLinks: { include: { representative: true } },
  processingLogs: { orderBy: { createdAt: "asc" as const } },
} as const;

function serializeAsset(asset: AssetWithRelations): KnowledgeAssetRecord {
  return {
    id: asset.id,
    kind: fromAssetKind(asset.kind),
    status: fromAssetStatus(asset.status),
    visibility: fromVisibility(asset.visibility),
    title: asset.title,
    originalFileName: asset.originalFileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sourceUrl: asset.sourceUrl,
    sourceText: asset.sourceText,
    sourceObjectBucket: asset.sourceObjectBucket,
    sourceObjectKey: asset.sourceObjectKey,
    sourceObjectEtag: asset.sourceObjectEtag,
    sourceObjectVersion: asset.sourceObjectVersion,
    sourceObjectChecksum: asset.sourceObjectChecksum,
    extractedText: asset.extractedText,
    summary: asset.summary,
    tags: asset.tags,
    autoTags: asset.autoTags,
    checksum: asset.checksum,
    processingError: asset.processingError,
    processingVersion: asset.processingVersion,
    vectorBackend: asset.vectorBackend,
    vectorUri: asset.vectorUri,
    vectorChunkCount: asset.vectorChunkCount,
    embeddingModel: asset.embeddingModel,
    indexedAt: asset.indexedAt?.toISOString() ?? null,
    processedAt: asset.processedAt?.toISOString() ?? null,
    archivedAt: asset.archivedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    representativeLinks: asset.representativeLinks.map((link) => ({
      representativeId: link.representativeId,
      representativeSlug: link.representative.slug,
      representativeName: link.representative.displayName,
      usageMode: fromUsageMode(link.usageMode),
      reviewStatus: fromReviewStatus(link.reviewStatus),
      enabled: link.enabled,
      priority: link.priority,
    })),
    processingLogs: asset.processingLogs.map((log) => ({
      id: log.id,
      stage: log.stage,
      level: log.level.toLowerCase() as "info" | "warning" | "error",
      message: log.message,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    })),
  };
}

function toAssetKind(value: z.infer<typeof assetKindSchema>): KnowledgeAssetKind { return value.toUpperCase() as KnowledgeAssetKind; }
function fromAssetKind(value: KnowledgeAssetKind): z.infer<typeof assetKindSchema> { return value.toLowerCase() as z.infer<typeof assetKindSchema>; }
function toAssetStatus(value: NonNullable<KnowledgeAssetListFilters["status"]>): KnowledgeAssetStatus { return value.toUpperCase() as KnowledgeAssetStatus; }
function fromAssetStatus(value: KnowledgeAssetStatus): KnowledgeAssetRecord["status"] { return value.toLowerCase() as KnowledgeAssetRecord["status"]; }
function toVisibility(value: z.infer<typeof assetVisibilitySchema>): KnowledgeAssetVisibility { return value.toUpperCase() as KnowledgeAssetVisibility; }
function fromVisibility(value: KnowledgeAssetVisibility): z.infer<typeof assetVisibilitySchema> { return value.toLowerCase() as z.infer<typeof assetVisibilitySchema>; }
function toUsageMode(value: z.infer<typeof usageModeSchema>): KnowledgeAssetUsageMode { return value.toUpperCase() as KnowledgeAssetUsageMode; }
function fromUsageMode(value: KnowledgeAssetUsageMode): z.infer<typeof usageModeSchema> { return value.toLowerCase() as z.infer<typeof usageModeSchema>; }
function toReviewStatus(value: z.infer<typeof reviewStatusSchema>): KnowledgeAssetReviewStatus { return value.toUpperCase() as KnowledgeAssetReviewStatus; }
function fromReviewStatus(value: KnowledgeAssetReviewStatus): z.infer<typeof reviewStatusSchema> { return value.toLowerCase() as z.infer<typeof reviewStatusSchema>; }

function shouldUseDemoKnowledge(ownerId?: string | null) {
  void ownerId;
  return !process.env.DATABASE_URL?.trim();
}

function demoRepresentativeOptions(): KnowledgeRepresentativeOption[] {
  return [{ id: demoRepresentative.id, slug: demoRepresentative.slug, name: demoRepresentative.name }];
}

function demoLog(stage: string, level: "info" | "warning" | "error", message: string): KnowledgeAssetRecord["processingLogs"][number] {
  return { id: `log_${randomUUID()}`, stage, level, message, metadata: null, createdAt: new Date().toISOString() };
}

function toDemoLink(link: z.output<typeof representativeLinkSchema>): KnowledgeAssetRecord["representativeLinks"][number] {
  const representative = demoRepresentativeOptions().find((option) => option.id === link.representativeId)!;
  return {
    representativeId: link.representativeId,
    representativeSlug: representative.slug,
    representativeName: representative.name,
    usageMode: link.usageMode,
    reviewStatus: link.reviewStatus,
    enabled: link.enabled,
    priority: link.priority,
  };
}

function validateDemoLinks(links: Array<z.output<typeof representativeLinkSchema>>) {
  const allowed = new Set(demoRepresentativeOptions().map((option) => option.id));
  if (new Set(links.map((link) => link.representativeId)).size !== links.length) {
    throw new KnowledgeLibraryError("同一个代表不能重复关联。", 422);
  }
  if (links.some((link) => !allowed.has(link.representativeId))) {
    throw new KnowledgeLibraryError("包含无权访问的代表。", 403);
  }
}

function requireDemoAsset(assetId: string) {
  const asset = demoKnowledgeAssets.find((item) => item.id === assetId);
  if (!asset) throw new KnowledgeLibraryError("Knowledge asset not found.", 404);
  return asset;
}

async function processDemoKnowledgeAsset(
  asset: KnowledgeAssetRecord,
  options: { staleRepresentativeSlugs?: string[] } = {},
): Promise<KnowledgeAssetRecord> {
  if (asset.status === "archived") throw new KnowledgeLibraryError("Archived knowledge must be restored before reprocessing.", 409);
  asset.status = "processing";
  asset.processingError = null;
  asset.processingVersion += 1;
  asset.processingLogs.push(demoLog("extract", "info", "开始提取并规范化知识内容。"));
  try {
    const text = normalizeExtractedText(await resolveAssetText({
      kind: asset.kind,
      sourceText: asset.sourceText,
      sourceUrl: asset.sourceUrl,
      sourceObjectBucket: asset.sourceObjectBucket,
      sourceObjectKey: asset.sourceObjectKey,
      originalFileName: asset.originalFileName,
      mimeType: asset.mimeType,
    }));
    if (text.length < 20) throw new KnowledgeLibraryError("提取内容过短，请提供至少 20 个字符的有效正文。", 422);
    asset.extractedText = text;
    asset.summary = buildKnowledgeSummary(text);
    asset.autoTags = inferKnowledgeTags(text, asset.title);
    asset.checksum = createHash("sha256").update(text).digest("hex");
    asset.processingLogs.push(demoLog("vectorize", "info", "正文已分块，正在写入向量索引。"));
    const vector = await indexKnowledgeText({
      ownerId: "demo",
      assetId: asset.id,
      title: asset.title,
      text,
      checksum: asset.checksum,
      representativeSlugs: asset.representativeLinks
        .filter((link) => link.enabled && link.reviewStatus === "approved")
        .map((link) => link.representativeSlug),
      ...(options.staleRepresentativeSlugs
        ? { staleRepresentativeSlugs: options.staleRepresentativeSlugs }
        : {}),
    });
    asset.vectorBackend = vector.backend;
    asset.vectorUri = vector.uri;
    asset.vectorChunkCount = vector.chunkCount;
    asset.embeddingModel = vector.embeddingModel;
    asset.indexedAt = vector.indexedAt.toISOString();
    asset.status = "ready";
    asset.processedAt = new Date().toISOString();
    asset.updatedAt = new Date().toISOString();
    asset.processingLogs.push(demoLog("complete", "info", `知识资产处理完成，已生成 ${vector.chunkCount} 个检索分块。`));
  } catch (error) {
    asset.status = "failed";
    asset.processingError = error instanceof Error ? error.message : "知识内容处理失败。";
    asset.indexedAt = null;
    asset.processingLogs.push(demoLog("failed", "error", asset.processingError));
  }
  return cloneDemoAsset(asset);
}

function filterDemoAssets(assets: KnowledgeAssetRecord[], filters: KnowledgeAssetListFilters) {
  const query = filters.query?.trim().toLowerCase();
  return assets.filter((asset) => {
    if (!filters.includeArchived && !filters.status && asset.status === "archived") return false;
    if (filters.status && asset.status !== filters.status) return false;
    if (filters.kind && asset.kind !== filters.kind) return false;
    if (filters.visibility && asset.visibility !== filters.visibility) return false;
    if (filters.tag && !asset.tags.includes(filters.tag)) return false;
    if (filters.representativeId && !asset.representativeLinks.some((link) => link.representativeId === filters.representativeId && link.enabled)) return false;
    return !query || [asset.title, asset.originalFileName ?? "", asset.sourceUrl ?? "", ...asset.tags, ...asset.autoTags].join(" ").toLowerCase().includes(query);
  });
}

function cloneDemoAsset(asset: KnowledgeAssetRecord): KnowledgeAssetRecord {
  return structuredClone(asset);
}

const demoKnowledgeAssets: KnowledgeAssetRecord[] = [
  makeSeedAsset({
    id: "knowledge_founder_profile",
    kind: "pdf",
    title: "Founder profile 2026",
    fileName: "Founder-profile-2026.pdf",
    tags: ["创始人", "品牌"],
    autoTags: ["团队", "品牌", "服务"],
    visibility: "selected_representatives",
    summary: "Lin 专注于 AI automation、代表型 agent 体验和业务流程设计，帮助有稳定 inbound 的小团队建立可信、可控的数字代表。",
    text: "Lin 是 Delegate 的创始人，专注于 AI automation、数字代表体验和服务流程设计。Delegate 帮助小团队将重复的 inbound 接待、资格筛选、资料交付和人工转接流程结构化。对外沟通应清晰、直接、礼貌，并优先给出可执行的下一步。",
    linked: true,
  }),
  makeSeedAsset({
    id: "knowledge_service_policy",
    kind: "docx",
    title: "服务范围与交付政策",
    fileName: "service-policy.docx",
    tags: ["服务", "政策"],
    autoTags: ["服务", "政策", "价格"],
    visibility: "organization_shared",
    summary: "说明咨询服务的适用客户、标准交付范围、报价边界、退款原则和必须转人工处理的情况。",
    text: "本政策说明 Delegate 咨询服务的适用范围。数字代表可以介绍服务、收集预算与时间要求，但不得直接承诺最终报价、折扣或退款。涉及敏感资料、合同条款和高价值交易时必须转人工审批。",
    linked: true,
  }),
  makeSeedAsset({
    id: "knowledge_product_faq",
    kind: "markdown",
    title: "Delegate 产品 FAQ",
    fileName: "product-faq.md",
    tags: ["产品", "FAQ"],
    autoTags: ["产品", "FAQ", "技术"],
    visibility: "public_material",
    summary: "覆盖数字代表是什么、能完成哪些公开任务、知识权限如何生效，以及何时需要主人审批。",
    text: "Delegate 是数字代表操作系统。数字代表使用已授权的公开知识回答常见问题、筛选线索、收集需求并交付公开资料。私有文件、账号操作、退款、折扣和敏感材料默认不能自动访问或执行，需要主人明确审批。",
    linked: false,
  }),
];

function makeSeedAsset(input: {
  id: string;
  kind: KnowledgeAssetRecord["kind"];
  title: string;
  fileName: string;
  tags: string[];
  autoTags: string[];
  visibility: KnowledgeAssetRecord["visibility"];
  summary: string;
  text: string;
  linked: boolean;
}): KnowledgeAssetRecord {
  const createdAt = "2026-07-12T03:20:00.000Z";
  return {
    id: input.id,
    kind: input.kind,
    status: "ready",
    visibility: input.visibility,
    title: input.title,
    originalFileName: input.fileName,
    mimeType: null,
    sizeBytes: 128_400,
    sourceUrl: null,
    sourceText: input.text,
    sourceObjectBucket: null,
    sourceObjectKey: null,
    sourceObjectEtag: null,
    sourceObjectVersion: null,
    sourceObjectChecksum: null,
    extractedText: input.text,
    summary: input.summary,
    tags: input.tags,
    autoTags: input.autoTags,
    checksum: createHash("sha256").update(input.text).digest("hex"),
    processingError: null,
    processingVersion: 1,
    vectorBackend: "memory",
    vectorUri: `viking://resources/delegate/workspaces/demo/knowledge/${input.id}.md`,
    vectorChunkCount: 1,
    embeddingModel: "deterministic-demo-embedding",
    indexedAt: createdAt,
    processedAt: createdAt,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
    representativeLinks: input.linked ? [{ representativeId: demoRepresentative.id, representativeSlug: demoRepresentative.slug, representativeName: demoRepresentative.name, usageMode: "both", reviewStatus: "approved", enabled: true, priority: 80 }] : [],
    processingLogs: [
      { id: `${input.id}_queued`, stage: "queued", level: "info", message: "知识资产已创建。", metadata: null, createdAt },
      { id: `${input.id}_complete`, stage: "complete", level: "info", message: "知识资产处理完成，可供已授权代表使用。", metadata: null, createdAt },
    ],
  };
}
