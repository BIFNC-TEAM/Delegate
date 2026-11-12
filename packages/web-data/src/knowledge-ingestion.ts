import { readKnowledgeSource, deleteKnowledgeSource } from "./knowledge-storage";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getKnowledgeAsset, processKnowledgeAsset, extractKnowledgeFile, replaceKnowledgeAssetSource, KnowledgeLibraryError, type KnowledgeAssetSourceReplacementInput } from "./knowledge-library";
import { knowledgeIngestionContext, KnowledgeProcessingPending, type IngestionCheckpoint } from "./knowledge-ingestion-context";

/** Persist before acknowledging the upload; the runner owns all expensive processing. */
export async function enqueueKnowledgeIngestion(ownerId: string | null | undefined, assetId: string, replacement?: KnowledgeAssetSourceReplacementInput) {
  if (!process.env.DATABASE_URL) {
    if (replacement) {
      const source = await readKnowledgeSource({ bucket: replacement.sourceObjectBucket, objectKey: replacement.sourceObjectKey });
      await extractKnowledgeFile({ bytes: source.bytes, fileName: replacement.originalFileName, mimeType: replacement.mimeType });
      await replaceKnowledgeAssetSource(ownerId, assetId, replacement);
    }
    return processKnowledgeAsset(ownerId, assetId);
  }
  const asset = await getKnowledgeAsset(ownerId, assetId);
  const record = await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: assetId }, select: { ownerId: true } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assetId}))`;
    const existing = await tx.knowledgeIngestionJob.findUnique({ where: { assetId } });
    if (existing && ["pending", "running"].includes(existing.status)) {
      if (replacement) throw new KnowledgeLibraryError("该文件仍在处理中，请完成后再替换。", 409);
      return;
    }
    const checkpoint = replacement ? { replacement: JSON.stringify(replacement) } : {};
    await tx.knowledgeIngestionJob.upsert({
      where: { assetId },
      create: { assetId, ownerId: record.ownerId, checkpoint },
      update: { status: "pending", checkpoint, availableAt: new Date(), attempts: 0, error: null, leaseToken: null, leaseExpiresAt: null },
    });
  });
  return replacement ? { ...asset, status: "processing" as const, processingError: null } : asset;
}

export async function runKnowledgeIngestionTick(assetId?: string): Promise<void> {
  // Recover the narrow crash window between saving an upload and enqueuing it.
  await prisma.$executeRaw`
    INSERT INTO "KnowledgeIngestionJob" ("assetId", "ownerId", "status", "availableAt", "updatedAt")
    SELECT a.id, a."ownerId", 'pending', NOW(), NOW() FROM "KnowledgeAsset" a
    WHERE (${assetId ?? null}::text IS NULL OR a.id = ${assetId ?? null}) AND a.status = 'PROCESSING' AND a."updatedAt" < NOW() - INTERVAL '1 minute'
      AND NOT EXISTS (SELECT 1 FROM "KnowledgeIngestionJob" j WHERE j."assetId" = a.id)
    ON CONFLICT ("assetId") DO NOTHING`;
  const token = randomUUID();
  const now = new Date();
  const job = await prisma.$transaction(async (tx) => {
    // One parsing slot across runner replicas, not just one browser tab.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(72819411)`;
    if (await tx.knowledgeIngestionJob.count({ where: { status: "running", leaseExpiresAt: { gt: now } } })) return null;
    const next = await tx.knowledgeIngestionJob.findFirst({
      where: { ...(assetId ? { assetId } : {}), OR: [{ status: "pending", availableAt: { lte: now } }, { status: "running", leaseExpiresAt: { lte: now } }] },
      orderBy: { availableAt: "asc" },
    });
    if (!next) return null;
    return tx.knowledgeIngestionJob.update({ where: { assetId: next.assetId }, data: {
      status: "running", leaseToken: token, leaseExpiresAt: new Date(Date.now() + 600_000), attempts: { increment: 1 },
    } });
  });
  if (!job) return;
  const owned = { assetId: job.assetId, leaseToken: token, status: "running" };
  const heartbeat = setInterval(() => {
    void prisma.knowledgeIngestionJob.updateMany({ where: owned, data: { leaseExpiresAt: new Date(Date.now() + 600_000) } }).catch(() => undefined);
  }, 30_000);
  const checkpoint = (job.checkpoint ?? {}) as IngestionCheckpoint;
  try {
    await knowledgeIngestionContext.run({ checkpoint, save: async (key, value) => {
      checkpoint[key] = value;
      const saved = await prisma.knowledgeIngestionJob.updateMany({ where: owned, data: { checkpoint } });
      if (!saved.count) throw new KnowledgeProcessingPending("处理任务已交接，等待继续。");
    } }, async () => {
      if (checkpoint.replacement && !checkpoint.replacementApplied) {
        const replacement = JSON.parse(checkpoint.replacement) as KnowledgeAssetSourceReplacementInput;
        const source = await readKnowledgeSource({ bucket: replacement.sourceObjectBucket, objectKey: replacement.sourceObjectKey });
        // Old source and index stay usable until the candidate has passed extraction and size checks.
        const extracted = await extractKnowledgeFile({ bytes: source.bytes, fileName: replacement.originalFileName, mimeType: replacement.mimeType });
        await replaceKnowledgeAssetSource(job.ownerId, job.assetId, replacement);
        await prisma.knowledgeAsset.update({ where: { id: job.assetId }, data: { extractedText: extracted.text } });
        await knowledgeIngestionContext.getStore()!.save("extracted", "yes");
        await knowledgeIngestionContext.getStore()!.save("replacementApplied", "yes");
      }
      const result = await processKnowledgeAsset(job.ownerId, job.assetId);
      await prisma.knowledgeIngestionJob.updateMany({ where: owned, data: {
        status: result.status === "ready" ? "completed" : "failed", error: result.processingError,
        leaseToken: null, leaseExpiresAt: null,
      } });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识处理暂时中断。";
    // Polls resume the saved provider task; they do not resubmit the document.
    const pending = error instanceof KnowledgeProcessingPending && job.attempts < 360;
    await prisma.knowledgeIngestionJob.updateMany({ where: owned, data: {
      status: pending ? "pending" : "failed", availableAt: new Date(Date.now() + 10_000),
      error: message, leaseToken: null, leaseExpiresAt: null,
    } });
    if (!pending && checkpoint.replacement && !checkpoint.replacementApplied) {
      const candidate = JSON.parse(checkpoint.replacement) as KnowledgeAssetSourceReplacementInput;
      await deleteKnowledgeSource({ bucket: candidate.sourceObjectBucket, objectKey: candidate.sourceObjectKey }).catch(() => undefined);
    }
    if (!pending) await prisma.knowledgeAsset.updateMany({ where: { id: job.assetId, status: "PROCESSING" }, data: {
      status: "FAILED", processingError: message,
    } });
  } finally { clearInterval(heartbeat); }
}

/** Upload progress may describe a rejected replacement while the original asset remains ready. */
export async function getKnowledgeIngestionProgress(ownerId: string | null | undefined, assetId: string) {
  const asset = await getKnowledgeAsset(ownerId, assetId);
  if (!process.env.DATABASE_URL) return asset;
  const job = await prisma.knowledgeIngestionJob.findUnique({ where: { assetId } });
  if (!job) return asset;
  if (["pending", "running"].includes(job.status)) return { ...asset, status: "processing" as const };
  if (job.status === "failed") return { ...asset, status: "failed" as const, processingError: job.error ?? asset.processingError };
  return asset;
}
