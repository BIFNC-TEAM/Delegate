import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ remove: vi.fn(), tempUpload: vi.fn(), addResource: vi.fn(), getTask: vi.fn(), findResourceTasks: vi.fn() }));
vi.mock("@delegate/openviking", () => ({
  resolveOpenVikingEnv: () => ({ enabled: true, hasModelCredentials: true, timeoutMs: 100, embeddingModel: "test" }),
  buildOpenVikingAgentId: () => "test", buildRepresentativeResourceRootUri: () => "viking://resources/rep/", sanitizeVikingSegment: (s: string) => s,
  OpenVikingClient: class { remove = calls.remove; tempUpload = calls.tempUpload; addResource = calls.addResource; getTask = calls.getTask; findResourceTasks = calls.findResourceTasks; },
}));
import { indexKnowledgeText } from "../src/knowledge-vector";
import { knowledgeIngestionContext, KnowledgeProcessingPending } from "../src/knowledge-ingestion-context";
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("DATABASE_URL", "test"); calls.tempUpload.mockResolvedValue({ temp_file_id: "temp" }); calls.addResource.mockResolvedValue({ task_id: "task", status: "pending" }); });
afterEach(() => vi.unstubAllEnvs());
const params = { ownerId: "owner", assetId: "asset", title: "test", text: "Full text retained", checksum: "abc", representativeSlugs: [] };
function fixture() {
 const checkpoint: Record<string,string> = {};
 const run = () => knowledgeIngestionContext.run({ checkpoint, save: async (key, value) => { checkpoint[key] = value; } }, () => indexKnowledgeText(params));
 return { checkpoint, run };
}
describe("durable OpenViking task polling", () => {
 it("submits once, keeps pending work, then completes from the saved task", async () => {
  const { run } = fixture(); await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
  calls.getTask.mockResolvedValueOnce({ status: "running" }).mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce({ status: "completed" });
  await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
  await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
  await expect(run()).resolves.toMatchObject({ backend: "openviking" });
  expect(calls.addResource).toHaveBeenCalledOnce(); expect(calls.remove).toHaveBeenCalledOnce();
  expect(calls.addResource.mock.calls[0]?.[0]).toMatchObject({ wait: false });
 });
 it("recovers a submitted task whose HTTP response was lost without resubmitting", async () => {
  const { run } = fixture(); calls.addResource.mockRejectedValueOnce(new Error("fetch failed"));
  await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
  calls.findResourceTasks.mockResolvedValue([{ task_id: "old", status: "completed", created_at: 1 }, { task_id: "recovered", status: "completed", created_at: Date.now() / 1000 }]); calls.getTask.mockResolvedValue({ status: "completed" });
  await expect(run()).resolves.toMatchObject({ backend: "openviking" });
  expect(calls.addResource).toHaveBeenCalledOnce(); expect(calls.getTask).toHaveBeenCalledWith("recovered");
 });
 it("does not mark provider failures ready or delete their resources on failure", async () => {
  const { run } = fixture(); await expect(run()).rejects.toBeInstanceOf(KnowledgeProcessingPending);
  calls.getTask.mockResolvedValue({ status: "failed", error: "embedding failed" });
  await expect(run()).rejects.toThrow("embedding failed"); expect(calls.remove).toHaveBeenCalledOnce();
 });
});
