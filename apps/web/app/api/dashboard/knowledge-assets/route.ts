import { after, NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  KnowledgeLibraryError,
  checksumKnowledgeSource,
  createKnowledgeAsset,
  deleteKnowledgeSource,
  detectKnowledgeFileKind,
  findKnowledgeFileConflicts,
  getKnowledgeAsset,
  listKnowledgeAssets,
  listKnowledgeRepresentativeOptions,
  replaceKnowledgeAssetSource,
  resolveUniqueKnowledgeAssetTitle,
  resolveKnowledgeLibraryOwnerId,
  processKnowledgeAsset,
  storeKnowledgeSource,
  type KnowledgeAssetCreateInput,
  type KnowledgeAssetListFilters,
} from "@delegate/web-data";

import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";

export async function GET(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const params = new URL(request.url).searchParams;
    const filters: KnowledgeAssetListFilters = {
      ...(params.get("query") ? { query: params.get("query")! } : {}),
      ...(readEnum(params, "status", ["processing", "ready", "failed", "archived"] as const) ? { status: readEnum(params, "status", ["processing", "ready", "failed", "archived"] as const)! } : {}),
      ...(readEnum(params, "kind", ["pdf", "docx", "txt", "markdown", "url", "text"] as const) ? { kind: readEnum(params, "kind", ["pdf", "docx", "txt", "markdown", "url", "text"] as const)! } : {}),
      ...(readEnum(params, "visibility", ["owner_only", "organization_shared", "selected_representatives", "public_material"] as const) ? { visibility: readEnum(params, "visibility", ["owner_only", "organization_shared", "selected_representatives", "public_material"] as const)! } : {}),
      ...(params.get("tag") ? { tag: params.get("tag")! } : {}),
      ...(params.get("representativeId") ? { representativeId: params.get("representativeId")! } : {}),
      includeArchived: params.get("includeArchived") === "true",
    };
    const [assets, representatives] = await Promise.all([
      listKnowledgeAssets(ownerId, filters),
      listKnowledgeRepresentativeOptions(ownerId),
    ]);
    return NextResponse.json({ assets, representatives });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to load the knowledge library.");
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const ownerId = await resolveKnowledgeLibraryOwnerId(session?.ownerId, request.headers.get("x-delegate-representative"));
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        throw new KnowledgeLibraryError("请选择要上传的知识文件。", 422);
      }
      if (file.size > 15 * 1024 * 1024) {
        throw new KnowledgeLibraryError("文件不能超过 15 MB。", 413);
      }
      const kind = detectKnowledgeFileKind(file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const checksum = checksumKnowledgeSource(bytes);
      const conflictPolicy = readUploadConflictPolicy(form);
      const conflicts = await findKnowledgeFileConflicts(ownerId, {
        fileName: file.name,
        checksum,
      });
      if (conflictPolicy === "skip_duplicates" && conflicts.exact) {
        return NextResponse.json({
          asset: await getKnowledgeAsset(ownerId, conflicts.exact.id),
          upload: {
            outcome: "skipped_duplicate",
            conflictType: "exact",
            conflictAssetId: conflicts.exact.id,
          },
        });
      }
      const replacement = conflictPolicy === "replace_existing"
        ? conflicts.exact ?? conflicts.sameName
        : null;
      const stored = await storeKnowledgeSource({
        ownerId,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        bytes,
      });
      let asset;
      try {
        if (replacement) {
          asset = await replaceKnowledgeAssetSource(ownerId, replacement.id, {
            kind,
            originalFileName: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            sourceObjectBucket: stored.bucket,
            sourceObjectKey: stored.objectKey,
            ...(stored.etag ? { sourceObjectEtag: stored.etag } : {}),
            ...(stored.versionId ? { sourceObjectVersion: stored.versionId } : {}),
            sourceObjectChecksum: stored.checksum,
          });
        } else {
          const title = await resolveUniqueKnowledgeAssetTitle(
            ownerId,
            readFormString(form, "title") || file.name.replace(/\.[^.]+$/, ""),
          );
          asset = await createKnowledgeAsset(ownerId, {
            kind,
            title,
            visibility: readVisibility(form),
            originalFileName: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            sourceObjectBucket: stored.bucket,
            sourceObjectKey: stored.objectKey,
            ...(stored.etag ? { sourceObjectEtag: stored.etag } : {}),
            ...(stored.versionId ? { sourceObjectVersion: stored.versionId } : {}),
            sourceObjectChecksum: stored.checksum,
            tags: readJsonArray<string>(form, "tags"),
            representativeLinks: readJsonArray<NonNullable<KnowledgeAssetCreateInput["representativeLinks"]>[number]>(form, "representativeLinks"),
            createdBy: session?.email ?? session?.ownerId ?? "dashboard-owner",
          }, { processingMode: "deferred" });
        }
      } catch (error) {
        await deleteKnowledgeSource({ bucket: stored.bucket, objectKey: stored.objectKey }).catch(() => undefined);
        throw error;
      }
      const assetId = asset.id;
      after(async () => {
        await processKnowledgeAsset(ownerId, assetId);
      });
      return NextResponse.json({
        asset,
        upload: {
          outcome: replacement ? "replaced" : "created",
          ...(replacement
            ? {
                conflictType: conflicts.exact?.id === replacement.id ? "exact" : "same_name",
                conflictAssetId: replacement.id,
              }
            : conflicts.sameName
              ? { conflictType: "same_name", conflictAssetId: conflicts.sameName.id }
              : {}),
        },
      }, { status: replacement ? 200 : 201 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const {
      sourceObjectBucket: _sourceObjectBucket,
      sourceObjectKey: _sourceObjectKey,
      sourceObjectEtag: _sourceObjectEtag,
      sourceObjectVersion: _sourceObjectVersion,
      sourceObjectChecksum: _sourceObjectChecksum,
      ...publicBody
    } = body;
    const asset = await createKnowledgeAsset(ownerId, {
      ...(publicBody as KnowledgeAssetCreateInput),
      createdBy: session?.email ?? session?.ownerId ?? "dashboard-owner",
    }, { processingMode: "deferred" });
    const assetId = asset.id;
    after(async () => {
      await processKnowledgeAsset(ownerId, assetId);
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return knowledgeErrorResponse(error, "Failed to import knowledge.");
  }
}

function readEnum<const T extends readonly string[]>(params: URLSearchParams, key: string, allowed: T): T[number] | undefined {
  const value = params.get(key);
  return value && allowed.includes(value) ? (value as T[number]) : undefined;
}

function readFormString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readVisibility(form: FormData) {
  const value = readFormString(form, "visibility");
  const allowed = ["owner_only", "organization_shared", "selected_representatives", "public_material"] as const;
  return allowed.includes(value as (typeof allowed)[number]) ? value as (typeof allowed)[number] : "owner_only";
}

function readUploadConflictPolicy(form: FormData) {
  const value = readFormString(form, "conflictPolicy");
  const allowed = ["skip_duplicates", "replace_existing", "keep_both"] as const;
  return allowed.includes(value as (typeof allowed)[number])
    ? value as (typeof allowed)[number]
    : "skip_duplicates";
}

function readJsonArray<T>(form: FormData, key: string): T[] {
  const value = readFormString(form, key);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as T[];
  } catch {
    throw new KnowledgeLibraryError(`${key} 格式无效。`, 422);
  }
}

export function knowledgeErrorResponse(error: unknown, fallback: string) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof KnowledgeLibraryError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "提交内容无效。", issues: error.issues }, { status: 422 });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}
