import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ control: vi.fn(), runtime: vi.fn(), fullSnapshot: vi.fn(), minimalSnapshot: vi.fn(), principal: vi.fn(), revalidate: vi.fn(), accept: vi.fn(), model: vi.fn(), network: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn() }) }));
vi.mock("@delegate/web-data", async (original) => ({
  ...(await original<typeof import("@delegate/web-data")>()),
  controlPublicAudienceTask: mocks.control,
  getPublicRepresentativeRuntime: mocks.runtime,
  getPublicGenerationRunSnapshot: mocks.fullSnapshot,
  getPublicGenerationRunControlSnapshot: mocks.minimalSnapshot,
  acceptInboundConversationMessage: mocks.accept,
  enforcePublicChatNetworkAdmission: mocks.network,
}));
vi.mock("@delegate/model-runtime", async (original) => ({ ...(await original<typeof import("@delegate/model-runtime")>()), delegatePiAgentRuntime: { run: mocks.model } }));
vi.mock("../app/reps/[slug]/public-principal", () => ({
  resolvePublicAudienceRequestPrincipal: mocks.principal,
  publicAudiencePrincipalErrorStatus: (error: unknown) => error instanceof Error && error.message === "fixture_unauthorized" ? 401 : null,
  assertPublicAudienceResourceOwner: vi.fn(), setPublicAudienceSessionCookie: vi.fn(),
}));

import { POST } from "../app/reps/[slug]/chat/route";
import { GET } from "../app/reps/[slug]/chat/runs/[runId]/events/route";

const request = (message: string) => new Request("http://localhost/reps/rep/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, audienceIdentityId: "forged-owner" }) });

describe("owned task controls outside new-service admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1:1/delegate_test");
    mocks.runtime.mockResolvedValue({ status: "paused" });
    mocks.principal.mockResolvedValue({ principal: { audienceIdentityId: "signed-identity", audienceId: "signed-device" }, revalidate: mocks.revalidate, sessionState: {} });
    mocks.control.mockResolvedValue({ outcome: "cancel_requested", text: "已记录停止请求。", tasks: [] });
    mocks.minimalSnapshot.mockResolvedValue({ id: "run", status: "canceled", statusOnly: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["/status", "取消", "/cancel run"])("handles %s without model calls, new work or memory-body reads while paused", async message => {
    const response = await POST(request(message), { params: Promise.resolve({ slug: "rep" }) });
    expect(response.status).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith(expect.objectContaining({ representativeSlug: "rep", audienceIdentityId: "signed-identity", audienceId: "signed-device" }));
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.fullSnapshot).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ reply: { text: "已记录停止请求。" } });
  });

  it("still denies a new task and does not treat a cancellation-policy question as a control command", async () => {
    const response = await POST(request("取消订单的规则是什么"), { params: Promise.resolve({ slug: "rep" }) });
    expect(response.status).toBe(423);
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("requires a current principal before reading or canceling old work", async () => {
    mocks.principal.mockRejectedValue(new Error("fixture_unauthorized"));
    const response = await POST(request("/cancel run"), { params: Promise.resolve({ slug: "rep" }) });
    expect(response.status).toBe(401);
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it.each(["canceled", "waiting_approval", "waiting_human", "completed"])("streams only owned minimal %s state while service is paused", async status => {
    mocks.minimalSnapshot.mockResolvedValue({ id: "run", status, statusOnly: true });
    const response = await GET(new Request("http://localhost/reps/rep/chat/runs/run/events"), { params: Promise.resolve({ slug: "rep", runId: "run" }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"statusOnly":true');
    expect(mocks.minimalSnapshot).toHaveBeenCalledWith({ representativeSlug: "rep", runId: "run", audienceIdentityId: "signed-identity", audienceId: "signed-device" });
    expect(mocks.fullSnapshot).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalled();
    expect(mocks.revalidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.minimalSnapshot.mock.invocationCallOrder[0]!);
  });

  it("does not read a task after the captured principal fails revalidation", async () => {
    mocks.revalidate.mockRejectedValueOnce(new Error("fixture revoked"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(new Request("http://localhost/reps/rep/chat/runs/run/events"), { params: Promise.resolve({ slug: "rep", runId: "run" }) });
      expect(await response.text()).toContain("stream_failed");
      expect(mocks.minimalSnapshot).not.toHaveBeenCalled();
      expect(mocks.fullSnapshot).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
