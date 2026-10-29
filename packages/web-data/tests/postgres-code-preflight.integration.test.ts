import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The workspace package has no package.json entry point; load its real source,
// as the existing Broker lifecycle tests do. The hook bus itself is not mocked.
vi.mock("@delegate/lifecycle-hooks", async () => import("../../lifecycle-hooks/src/index"));
import { prisma } from "../src/prisma";
import { prisma as brokerDb } from "../../../apps/compute-broker/src/prisma";
import { createComputeSession } from "../../../apps/compute-broker/src/sessions";
import { evaluateExecutionRequest, getCodeExecutionPreflight } from "../../../apps/compute-broker/src/policy";
import { executeTool, processNextApprovedExecution } from "../../../apps/compute-broker/src/executions";
import { uploadComputeSessionInput } from "../../../apps/compute-broker/src/session-inputs";
import * as leases from "../../../apps/compute-broker/src/leases";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_code_preflight_database_required");
}
const suite = enabled ? describe : describe.skip;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = "print('SYNTHETIC_ONLY')";
const request = { capability: "exec" as const, subagentId: "compute-agent" as const, browserMode: "deterministic" as const, maxSteps: 1, allowMutations: false, hasPaidEntitlement: false,
  command: `python -c "import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString("base64")}'),'<pi-agent>','exec'))"`,
  compiledTask: { compilerVersion: "sandbox-task-compiler.v1" as const, instructionHash: hash("run synthetic"), codeHash: hash(source), riskClass: "self_contained_compute" as const, compilerProvider: "delegate-pi-runtime" } };

suite("actual Broker code admission against isolated PostgreSQL", () => {
  let dispatch: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { dispatch = vi.spyOn(leases, "ensureComputeSessionLease").mockRejectedValue(new Error("unexpected_provider_dispatch")); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { vi.restoreAllMocks(); await Promise.all([prisma.$disconnect(), brokerDb.$disconnect()]); });

  it("records a blocked execution and honest preflight despite matching legacy hashes and ALLOW", async () => {
    const f = await fixture();
    expect(await getCodeExecutionPreflight(f.sessionId)).toMatchObject({ available: false, profileId: null, reason: "code_execution_profile_unverified" });
    const evaluated = await evaluateExecutionRequest(f.sessionId, request);
    expect(evaluated.inlineCodeIntegrityVerified).toBe(true); expect(evaluated.decision.decision).toBe("allow");
    const result = await executeTool(f.sessionId, request);
    expect(result).toMatchObject({ outcome: "blocked", blockReasonCode: "code_execution_profile_unverified", execution: { status: "blocked" } });
    expect(await prisma.approvalRequest.count({ where: { sessionId: f.sessionId } })).toBe(0);
    const audit = await prisma.eventAudit.findFirstOrThrow({ where: { representativeId: f.repId, type: "TOOL_EXECUTION_REQUESTED" } });
    expect(audit.payload).toMatchObject({ decision: "deny", codeClassification: "untrusted_code", inlineCodeIntegrityVerified: true, codeExecutionProfileId: null });
    expect(JSON.stringify(audit.payload)).not.toContain(source);
    await expectNoDispatch(f); expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
  });

  it("rechecks a previously approved legacy command, cancels execution, and preserves the actual approval fact", async () => {
    const f = await fixture(); const payload = JSON.stringify(request);
    const execution = await prisma.toolExecution.create({ data: { sessionId: f.sessionId, capability: "EXEC", subagentId: "compute-agent", status: "QUEUED",
      requestedCommand: request.command, requestPayload: payload, workingDirectory: "/workspace", policyDecision: "ASK" } });
    const approval = await prisma.approvalRequest.create({ data: { representativeId: f.repId, sessionId: f.sessionId, toolExecutionId: execution.id,
      subagentId: "compute-agent", status: "APPROVED", resolvedAt: new Date(), resolvedBy: "synthetic-owner", reason: "legacy", requestedActionSummary: "Legacy self-contained label", riskSummary: "legacy label", requestPayloadHash: hash(payload) } });
    await prisma.toolExecution.update({ where: { id: execution.id }, data: { approvalRequestId: approval.id } });
    expect(await processNextApprovedExecution()).toBe(true);
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: execution.id } })).toMatchObject({ status: "CANCELED", policyDecision: "DENY", executionLeaseToken: null });
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).toMatchObject({ status: "APPROVED" });
    expect(await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } })).toMatchObject({ failureReason: "code_execution_profile_unverified" });
    expect(await processNextApprovedExecution()).toBe(false);
    await expectNoDispatch(f); expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
  });

  it("blocks code attachment upload before acquiring a lease or transferring bytes", async () => {
    const f = await fixture(); const content = "SYNTHETIC_ATTACHMENT";
    await expect(uploadComputeSessionInput(f.sessionId, { fileName: "input.txt", mimeType: "text/plain", sizeBytes: Buffer.byteLength(content), checksum: hash(content), base64: Buffer.from(content).toString("base64") }))
      .rejects.toThrow("code_execution_profile_unverified");
    await expectNoDispatch(f); expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
  });

  it("does not bypass current session authorization/expiry to return a preflight result", async () => {
    const f = await fixture(); await prisma.computeSession.update({ where: { id: f.sessionId }, data: { endedAt: new Date() } });
    await expect(getCodeExecutionPreflight(f.sessionId)).rejects.toThrow("compute_session_already_terminated");
    expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
  });
});

async function expectNoDispatch(f: { repId: string; sessionId: string }) {
  expect(await prisma.sandboxIdentity.count({ where: { representativeId: f.repId } })).toBe(0);
  expect(await prisma.artifact.count({ where: { sessionId: f.sessionId } })).toBe(0);
  expect(await prisma.ledgerEntry.count({ where: { sessionId: f.sessionId } })).toBe(0);
  expect((await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } })).containerId).toBeNull();
}
async function fixture() {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic code owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `code-preflight-${randomUUID()}`, displayName: "Synthetic", roleSummary: "Test", tone: "neutral",
    languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Test", allowedSkills: [], actionGate: {},
    computeEnabled: true, computeDefaultPolicyMode: "ALLOW", computeNetworkMode: "FULL", computeFilesystemMode: "EPHEMERAL_FULL", computeAutoApproveTokenLimit: 10000 } });
  await prisma.capabilityPolicyProfile.create({ data: { representativeId: rep.id, name: "Fixture allow", isDefault: true, defaultDecision: "ALLOW", networkMode: "FULL", filesystemMode: "EPHEMERAL_FULL",
    rules: { create: [{ id: `${rep.id}_exec_owner_mode`, capability: "EXEC", decision: "ALLOW" }] } } });
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, snapshot: { compute: {
    enabled: true, defaultPolicyMode: "allow", baseImage: rep.computeBaseImage, maxSessionMinutes: 15, autoApproveTokenLimit: 10000, artifactRetentionDays: 14,
    networkMode: "full", networkAllowlist: [], filesystemMode: "ephemeral_full", capabilityModes: { exec: "allow", read: "allow", write: "allow", process: "allow", browser: "allow", mcp: "allow" },
  } } } });
  await prisma.representative.update({ where: { id: rep.id }, data: { activeVersionId: version.id } });
  const contact = await prisma.contact.create({ data: { representativeId: rep.id, sourceChannel: "web" } });
  const conversation = await prisma.conversation.create({ data: { representativeId: rep.id, contactId: contact.id, channel: "PRIVATE_CHAT", sourceChannel: "web" } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, senderType: "AUDIENCE", text: "run synthetic" } });
  const run = await prisma.generationRun.create({ data: { conversationId: conversation.id, inputMessageId: message.id, representativeVersionId: version.id, idempotencyKey: randomUUID() } });
  const session = await createComputeSession({ representativeId: rep.id, requestedBy: "owner", subagentId: "compute-agent", requestedCapabilities: ["exec"], reason: "isolated-test" });
  await prisma.computeSession.update({ where: { id: session.session.id }, data: { generationRunId: run.id } });
  return { repId: rep.id, sessionId: session.session.id };
}
