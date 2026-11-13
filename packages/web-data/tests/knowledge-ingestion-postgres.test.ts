import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const mocks = vi.hoisted(() => ({ index: vi.fn(), read: vi.fn() }));
vi.mock("../src/knowledge-vector", () => ({ indexKnowledgeText: mocks.index, removeKnowledgeTextIndex: vi.fn() }));
vi.mock("../src/knowledge-storage", async (original) => ({ ...await original<typeof import("../src/knowledge-storage")>(), readKnowledgeSource: mocks.read, deleteKnowledgeSource: vi.fn().mockResolvedValue(undefined) }));
import { prisma } from "../src/prisma";
import { enqueueKnowledgeIngestion, runKnowledgeIngestionTick, getKnowledgeIngestionProgress } from "../src/knowledge-ingestion";
import { archiveKnowledgeAsset } from "../src/knowledge-library";
import { KnowledgeProcessingPending } from "../src/knowledge-ingestion-context";
const enabled = process.env.KNOWLEDGE_LOCAL_PG_TEST === "1";
if (enabled) {
  const target = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.port !== "15432") throw new Error("Local test database required");
}
const ids: string[] = [];
afterAll(async () => {
  if (enabled) {
    for (const ownerId of ids) {
      await prisma.knowledgeIngestionJob.deleteMany({ where: { ownerId } });
      await prisma.owner.delete({ where: { id: ownerId } });
    }
  }
  await prisma.$disconnect();
});
async function fixture() {
 const owner = await prisma.owner.create({ data: { displayName: `knowledge-test-${randomUUID()}` } }); ids.push(owner.id);
 return prisma.knowledgeAsset.create({ data: { ownerId: owner.id, kind: "TEXT", title: "isolated integration test", sourceText: "测试资料正文，专门用于验证任务持久化与中断恢复，不关联任何代表。" } });
}
const done = () => ({ backend: "openviking", uri: "viking://resources/test", chunkCount: 1, embeddingModel: "test", indexedAt: new Date() });
describe.skipIf(!enabled)("local durable knowledge processing", () => {
 it("persists a job and completes it in the worker", async () => {
  const asset = await fixture(); mocks.index.mockResolvedValue(done());
  await enqueueKnowledgeIngestion(asset.ownerId, asset.id);
  expect((await prisma.knowledgeIngestionJob.findUniqueOrThrow({ where: { assetId: asset.id } })).status).toBe("pending");
  await runKnowledgeIngestionTick(asset.id);
  expect((await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("READY");
 });
 it("keeps a waiting task pending, then resumes saved extraction", async () => {
  const asset = await fixture(); mocks.index.mockRejectedValueOnce(new KnowledgeProcessingPending("still working")).mockResolvedValue(done());
  await enqueueKnowledgeIngestion(asset.ownerId, asset.id); await runKnowledgeIngestionTick(asset.id);
  const job = await prisma.knowledgeIngestionJob.findUniqueOrThrow({ where: { assetId: asset.id } });
  expect(job.status).toBe("pending"); expect(job.checkpoint).toMatchObject({ extracted: "yes" });
  await prisma.knowledgeIngestionJob.update({ where: { assetId: asset.id }, data: { availableAt: new Date(0) } });
  await runKnowledgeIngestionTick(asset.id);
  expect((await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("READY");
 });
 it("prevents archiving an active import so a late completion cannot restore it", async () => {
  const asset = await fixture(); await enqueueKnowledgeIngestion(asset.ownerId, asset.id);
  await expect(archiveKnowledgeAsset(asset.ownerId, asset.id, true)).rejects.toThrow("后台处理中");
 });
 it("reclaims an expired worker lease and finishes the saved job", async () => {
  const asset = await fixture(); mocks.index.mockResolvedValue(done()); await enqueueKnowledgeIngestion(asset.ownerId, asset.id);
  await prisma.knowledgeIngestionJob.update({ where: { assetId: asset.id }, data: { status: "running", leaseToken: "old-worker", leaseExpiresAt: new Date(0) } });
  await runKnowledgeIngestionTick(asset.id);
  expect((await prisma.knowledgeIngestionJob.findUniqueOrThrow({ where: { assetId: asset.id } })).status).toBe("completed");
 });
 it("rejects an oversized replacement without changing the previous usable asset", async () => {
  const asset = await fixture(); await prisma.knowledgeAsset.update({ where: { id: asset.id }, data: { status: "READY", extractedText: "previous content" } });
  mocks.read.mockResolvedValue({ bytes: new TextEncoder().encode("a".repeat(2_000_001)), contentType: "text/plain" });
  await enqueueKnowledgeIngestion(asset.ownerId, asset.id, { kind: "txt", originalFileName: "too-long.txt", mimeType: "text/plain", sizeBytes: 2_000_001, sourceObjectBucket: "test", sourceObjectKey: "test-candidate", sourceObjectChecksum: "a".repeat(64) });
  await runKnowledgeIngestionTick(asset.id);
  const stored = await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(stored.status).toBe("READY"); expect(stored.extractedText).toBe("previous content");
  expect(await getKnowledgeIngestionProgress(asset.ownerId, asset.id)).toMatchObject({ status: "failed", processingError: expect.stringContaining("2,000,000") });
 });
});
