import { createHmac, timingSafeEqual } from "node:crypto";

import {
  KnowledgeAssetReviewStatus,
  KnowledgeAssetStatus,
  KnowledgeAssetUsageMode,
  KnowledgeAssetVisibility,
} from "@prisma/client";

import { readKnowledgeSource } from "./knowledge-storage";
import { prisma } from "./prisma";

const PUBLIC_MATERIAL_LINK_TTL_SECONDS = 10 * 60;

export type GovernedPublicMaterialDelivery = {
  id: string;
  title: string;
  summary: string;
  url: string;
  processingVersion: number;
};

type LegacyMaterial = {
  id: string;
  title: string;
  summary: string;
  url?: string | undefined;
};

type PublicMaterialTokenPayload = {
  version: 1;
  assetId: string;
  representativeId: string;
  representativeSlug: string;
  processingVersion: number;
  checksum: string;
  expiresAt: number;
};

export async function resolveGovernedPublicMaterialDeliveries(input: {
  representativeId: string;
  representativeSlug: string;
  queryText: string;
  businessLabels?: string[];
  requestedOutcomes?: string[];
  legacyMaterials?: LegacyMaterial[];
  now?: Date;
}): Promise<GovernedPublicMaterialDelivery[]> {
  if (!process.env.DATABASE_URL?.trim()) {
    return selectLegacyDemoMaterials(
      input.legacyMaterials ?? [],
      buildMatchTerms(input),
    );
  }

  const rows = await prisma.knowledgeAsset.findMany({
    where: {
      status: KnowledgeAssetStatus.READY,
      visibility: KnowledgeAssetVisibility.PUBLIC_MATERIAL,
      archivedAt: null,
      OR: [
        { sourceUrl: { not: null } },
        {
          sourceObjectBucket: { not: null },
          sourceObjectKey: { not: null },
        },
      ],
      representativeLinks: {
        some: {
          representativeId: input.representativeId,
          enabled: true,
          reviewStatus: KnowledgeAssetReviewStatus.APPROVED,
          usageMode: {
            in: [
              KnowledgeAssetUsageMode.PUBLIC_MATERIAL,
              KnowledgeAssetUsageMode.BOTH,
            ],
          },
        },
      },
    },
    select: {
      id: true,
      title: true,
      summary: true,
      checksum: true,
      sourceObjectChecksum: true,
      processingVersion: true,
      tags: true,
      autoTags: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  const matchTerms = buildMatchTerms(input);
  const now = input.now ?? new Date();
  return rows
    .map((row, index) => ({
      row,
      index,
      score: scoreMaterial(
        `${row.title} ${row.summary ?? ""} ${row.tags.join(" ")} ${row.autoTags.join(" ")}`,
        matchTerms,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(({ row }) => {
      const checksum = row.sourceObjectChecksum || row.checksum || "unversioned";
      const token = signPublicMaterialToken({
        version: 1,
        assetId: row.id,
        representativeId: input.representativeId,
        representativeSlug: input.representativeSlug,
        processingVersion: row.processingVersion,
        checksum,
        expiresAt: Math.floor(now.getTime() / 1_000) + PUBLIC_MATERIAL_LINK_TTL_SECONDS,
      });
      return {
        id: row.id,
        title: row.title,
        summary: row.summary?.trim() || "公开资料",
        processingVersion: row.processingVersion,
        url: buildPublicMaterialDownloadUrl(
          input.representativeSlug,
          row.id,
          token,
        ),
      };
    });
}

export async function resolveGovernedPublicMaterialDownload(input: {
  representativeSlug: string;
  assetId: string;
  token: string;
  now?: Date;
}): Promise<
  | {
      kind: "redirect";
      url: string;
      fileName: string;
      processingVersion: number;
    }
  | {
      kind: "bytes";
      bytes: Uint8Array;
      contentType: string;
      fileName: string;
      processingVersion: number;
    }
> {
  const payload = verifyPublicMaterialToken(input.token, input.now ?? new Date());
  if (
    payload.assetId !== input.assetId
    || payload.representativeSlug !== input.representativeSlug
  ) {
    throw new PublicMaterialAccessError("Public material link does not match this resource.", 403);
  }
  const asset = await prisma.knowledgeAsset.findFirst({
    where: {
      id: input.assetId,
      status: KnowledgeAssetStatus.READY,
      visibility: KnowledgeAssetVisibility.PUBLIC_MATERIAL,
      archivedAt: null,
      processingVersion: payload.processingVersion,
      representativeLinks: {
        some: {
          representativeId: payload.representativeId,
          representative: { slug: input.representativeSlug },
          enabled: true,
          reviewStatus: KnowledgeAssetReviewStatus.APPROVED,
          usageMode: {
            in: [
              KnowledgeAssetUsageMode.PUBLIC_MATERIAL,
              KnowledgeAssetUsageMode.BOTH,
            ],
          },
        },
      },
    },
    select: {
      title: true,
      originalFileName: true,
      mimeType: true,
      sourceUrl: true,
      sourceObjectBucket: true,
      sourceObjectKey: true,
      sourceObjectChecksum: true,
      checksum: true,
      processingVersion: true,
    },
  });
  if (!asset) {
    throw new PublicMaterialAccessError("Public material is no longer available.", 404);
  }
  const currentChecksum = asset.sourceObjectChecksum || asset.checksum || "unversioned";
  if (currentChecksum !== payload.checksum) {
    throw new PublicMaterialAccessError("Public material link is stale.", 410);
  }
  const fileName = sanitizeDownloadFileName(asset.originalFileName || asset.title);
  const publicUrl = normalizePublicHttpUrl(asset.sourceUrl);
  if (publicUrl) {
    return {
      kind: "redirect",
      url: publicUrl,
      fileName,
      processingVersion: asset.processingVersion,
    };
  }
  if (!asset.sourceObjectBucket || !asset.sourceObjectKey) {
    throw new PublicMaterialAccessError("Public material source is unavailable.", 404);
  }
  const object = await readKnowledgeSource({
    bucket: asset.sourceObjectBucket,
    objectKey: asset.sourceObjectKey,
  });
  return {
    kind: "bytes",
    bytes: object.bytes,
    contentType: asset.mimeType || object.contentType || "application/octet-stream",
    fileName,
    processingVersion: asset.processingVersion,
  };
}

export class PublicMaterialAccessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 404 | 410,
  ) {
    super(message);
    this.name = "PublicMaterialAccessError";
  }
}

function signPublicMaterialToken(payload: PublicMaterialTokenPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function verifyPublicMaterialToken(token: string, now: Date): PublicMaterialTokenPayload {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature) {
    throw new PublicMaterialAccessError("Public material link is invalid.", 403);
  }
  const expectedSignature = sign(encoded);
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new PublicMaterialAccessError("Public material link is invalid.", 403);
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as PublicMaterialTokenPayload;
    if (
      payload.version !== 1
      || !payload.assetId
      || !payload.representativeId
      || !payload.representativeSlug
      || !Number.isSafeInteger(payload.processingVersion)
      || payload.processingVersion < 1
      || !payload.checksum
      || !Number.isSafeInteger(payload.expiresAt)
    ) {
      throw new Error("invalid payload");
    }
    if (payload.expiresAt <= Math.floor(now.getTime() / 1_000)) {
      throw new PublicMaterialAccessError("Public material link has expired.", 410);
    }
    return payload;
  } catch (error) {
    if (error instanceof PublicMaterialAccessError) throw error;
    throw new PublicMaterialAccessError("Public material link is invalid.", 403);
  }
}

function sign(value: string) {
  const secret =
    process.env.PUBLIC_MATERIAL_LINK_SECRET?.trim()
    || process.env.REP_PUBLIC_CHAT_SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_MATERIAL_LINK_SECRET or REP_PUBLIC_CHAT_SESSION_SECRET is required in production.",
    );
  }
  return createHmac("sha256", secret || "delegate-public-material-dev-secret")
    .update(value)
    .digest("base64url");
}

function buildMatchTerms(input: {
  queryText: string;
  businessLabels?: string[];
  requestedOutcomes?: string[];
}) {
  return [
    input.queryText,
    ...(input.businessLabels ?? []),
    ...(input.requestedOutcomes ?? []),
  ]
    .flatMap((value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/gu))
    .filter((value) => value.length >= 2);
}

function scoreMaterial(searchable: string, terms: string[]) {
  const normalized = searchable.toLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

function selectLegacyDemoMaterials(
  materials: LegacyMaterial[],
  matchTerms: string[],
): GovernedPublicMaterialDelivery[] {
  return materials
    .flatMap((material, index) => {
      const url = normalizePublicHttpUrl(material.url);
      return url
        ? [{ material, url, index, score: scoreMaterial(`${material.title} ${material.summary}`, matchTerms) }]
        : [];
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(({ material, url }) => ({
      id: material.id,
      title: material.title,
      summary: material.summary,
      url,
      processingVersion: 1,
    }));
}

function normalizePublicHttpUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function sanitizeDownloadFileName(value: string) {
  return value.trim().replace(/[\\/\0\r\n"]/g, "-").slice(0, 180) || "public-material";
}

function buildPublicMaterialDownloadUrl(
  representativeSlug: string,
  assetId: string,
  token: string,
) {
  const path = `/reps/${encodeURIComponent(representativeSlug)}/materials/${encodeURIComponent(assetId)}/download?token=${encodeURIComponent(token)}`;
  const configuredOrigin = process.env.NEXT_PUBLIC_REPRESENTATIVE_URL?.trim();
  if (!configuredOrigin) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_REPRESENTATIVE_URL is required for public material delivery in production.",
      );
    }
    return path;
  }
  try {
    const origin = new URL(configuredOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol)
      || origin.username
      || origin.password
      || origin.pathname !== "/"
      || origin.search
      || origin.hash
      || (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
    ) {
      throw new Error("invalid origin");
    }
    return new URL(path, origin).toString();
  } catch {
    throw new Error(
      "NEXT_PUBLIC_REPRESENTATIVE_URL must be a canonical HTTP(S) origin; production requires HTTPS.",
    );
  }
}
