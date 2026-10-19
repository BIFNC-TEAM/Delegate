import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/prisma", () => ({ prisma: { eventAudit: { create: mocks.create } } }));
vi.mock("@delegate/lifecycle-hooks", async () => import("../../../packages/lifecycle-hooks/src/index"));

import { computeLifecycleHooks } from "../src/lifecycle-hooks";

describe("compute audit persistence", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ id: "audit" }); });

  it("persists decision and references without command, private path or URL contents", async () => {
    const secret = "SYNTHETIC_AUDIT_CANARY";
    const event = {
      kind: "tool_preflight" as const,
      scope: { representativeId: "rep", contactId: "contact", conversationId: "conversation" },
      sessionId: "session", subagentId: "compute-agent", capability: "exec", decision: "allow" as const,
      reason: "published_policy_allow", requestedCommand: `echo ${secret}`, requestedPath: `/workspace/${secret}`,
      workingDirectory: `/workspace/${secret}`, remoteUrl: `https://user:${secret}@example.invalid/?token=${secret}`,
    };
    await computeLifecycleHooks.emit(event);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(secret);
    expect(mocks.create.mock.calls[0]![0].data.payload).toMatchObject({ sessionId: "session", capability: "exec", decision: "allow", commandPresent: true });
    expect(event.requestedCommand).toContain(secret);
  });

  it("does not print sensitive database errors when audit storage fails", async () => {
    const secret = "SYNTHETIC_DATABASE_ERROR";
    mocks.create.mockRejectedValue(new Error(`database failure with private payload ${secret}`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await computeLifecycleHooks.emit({ kind: "session_ended", scope: { representativeId: "rep" }, sessionId: "session", finalStatus: "FAILED", reason: secret });
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls.map(call => call.map(value => value instanceof Error ? value.message : value)))).not.toContain(secret);
    } finally { warn.mockRestore(); }
  });
});
