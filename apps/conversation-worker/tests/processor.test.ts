import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), operator: vi.fn(), deliveryWork: vi.fn(), setup: vi.fn(), pin: vi.fn(), fail: vi.fn(), run: vi.fn(), deliver: vi.fn(), defer: vi.fn(), cancel: vi.fn(), complete: vi.fn() }));
vi.mock("@delegate/web-data", async original => ({
  ...await original<typeof import("@delegate/web-data")>(),
  claimNextGenerationWorkItem: mocks.claim, claimNextOperatorMessageWorkItem: mocks.operator,
  claimNextConversationMessageDeliveryWorkItem: mocks.deliveryWork, getRepresentativeRuntimeSetupSnapshot: mocks.setup,
  pinGenerationAgentVariant: mocks.pin, failGenerationRun: mocks.fail, deferGenerationRunForHuman: mocks.defer,
  cancelGenerationPendingApprovals: mocks.cancel, completeInlineGenerationRun: mocks.complete,
}));
vi.mock("../src/generation-lease", () => ({ startGenerationLeaseHeartbeat: () => ({ confirmOwned: async () => undefined, assertOwned() { }, isLost: () => false, stop() { } }) }));
vi.mock("../src/processor-v2", () => ({ processV2ConversationTurn: mocks.run }));
vi.mock("../src/generation-delivery", async original => ({ ...await original<typeof import("../src/generation-delivery")>(), deliverGenerationOutput: mocks.deliver }));
import { processNextConversationWork } from "../src/processor";
const config = { port: 4040, pollMs: 500, telegramConversationPlatformMode: "worker" as const };
const item = () => ({ outboxId: "outbox", leaseAttempt: 1, runId: "run", conversationId: "conversation", representativeSlug: "any-representative", representativeVersionId: "version", representativeName: "Rep", channel: "web", userText: "Explain a map", contextSnapshot: {}, inputAttachments: [] });
beforeEach(() => {
  vi.clearAllMocks(); mocks.operator.mockResolvedValue(null); mocks.deliveryWork.mockResolvedValue(null);
  mocks.claim.mockResolvedValue(item()); mocks.setup.mockResolvedValue({ id: "rep" }); mocks.pin.mockResolvedValue("v2");
  mocks.run.mockResolvedValue({ processed: true, status: "completed" }); mocks.cancel.mockResolvedValue({ canceledCount: 1 });
  mocks.complete.mockResolvedValue({ message: { id: "output" } });
});
describe("single V2 worker entry", () => {
  it("routes a new request for any representative to V2 without an allowlist", async () => {
    await processNextConversationWork(config);
    expect(mocks.pin).toHaveBeenCalledExactlyOnceWith({ runId: "run", outboxId: "outbox", leaseAttempt: 1 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ item: expect.objectContaining({ representativeSlug: "any-representative" }) }));
  });
  it("retires an old checkpoint without model/tool replay or automatic retries", async () => {
    mocks.pin.mockResolvedValue("pi");
    mocks.claim.mockResolvedValue({ ...item(), contextSnapshot: { piApprovalContinuation: { status: "completed", checkpoint: { secret: "historical" } } } });
    expect(await processNextConversationWork(config)).toMatchObject({ status: "legacy_retired" });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "legacy_agent_runtime_retired", retryable: false }));
  });
  it("still delivers a persisted historical answer without generating or replaying anything", async () => {
    mocks.claim.mockResolvedValue({ ...item(), deliveryOnly: true, outputMessageId: "old-reply", outputText: "Persisted answer", contextSnapshot: { agentVariant: "pi" } });
    await processNextConversationWork(config);
    expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({ text: "Persisted answer", outputMessageId: "old-reply" }));
    expect(mocks.pin).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("preserves human ownership before the model boundary", async () => {
    mocks.claim.mockResolvedValue({ ...item(), controlState: "HUMAN_ACTIVE" });
    expect(await processNextConversationWork(config)).toMatchObject({ status: "waiting_human" });
    expect(mocks.defer).toHaveBeenCalledOnce(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("keeps deterministic cancellation of pending approvals without a model call", async () => {
    mocks.claim.mockResolvedValue({ ...item(), userText: "取消任务" });
    await processNextConversationWork(config);
    expect(mocks.cancel).toHaveBeenCalledOnce(); expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ countUsage: false }));
  });
  it("returns idle when the queue is empty", async () => {
    mocks.claim.mockResolvedValue(null);
    expect(await processNextConversationWork(config)).toEqual({ processed: false });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
