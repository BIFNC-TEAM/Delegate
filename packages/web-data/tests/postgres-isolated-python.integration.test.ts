import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
const transport = vi.hoisted(() => ({ loadInputs: vi.fn(), finalize: vi.fn(), bodies: new Map<string, Buffer>() }));
vi.mock("@delegate/lifecycle-hooks", async () => import("../../lifecycle-hooks/src/index"));
vi.mock("@delegate/web-data", async original => ({ ...await original<typeof import("@delegate/web-data")>(), loadGenerationInputAttachments: transport.loadInputs, finalizeComputeApprovalConversation: transport.finalize }));
vi.mock("../src/artifact-store", () => ({ readArtifactObject: vi.fn(async (key: string) => ({ buffer: transport.bodies.get(key)!, contentType: "text/plain" })) }));
import { prisma } from "../src/prisma";
import { prisma as brokerDb } from "../../../apps/compute-broker/src/prisma";
import { createComputeSession } from "../../../apps/compute-broker/src/sessions";
import { executeTool, processNextApprovedExecution, resolveApproval } from "../../../apps/compute-broker/src/executions";
import { getCodeExecutionPreflight } from "../../../apps/compute-broker/src/policy";
import { computeBrokerConfig } from "../../../apps/compute-broker/src/config";
import { reconcilePythonExecutions, retirePythonLease } from "../../../apps/compute-broker/src/isolated-python/broker-execution";
import { IsolatedPythonExecutionError } from "../../../apps/compute-broker/src/isolated-python/transport";
import * as leases from "../../../apps/compute-broker/src/sandbox-leases";
import * as artifacts from "../../../apps/compute-broker/src/artifacts";
import { getPublicConversationArtifactDownload } from "../src/public-compute-artifacts";
import { createAgentContextAuthorization } from "../src/agent-context-authorization";
import type { SandboxProvider } from "../../../apps/compute-broker/src/sandbox-provider";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_python_database_required");
}
const suite = enabled ? describe : describe.skip;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const receipt = { profile: "delegate.aio.single-python.v1" as const, termination: "exit" as const, exitCode: 0, stdout: "1012\n", stderr: "", cleanupConfirmed: true };
const configBefore = { ...computeBrokerConfig.tencent };
let provider: SandboxProvider;
let dispatch: Mock<NonNullable<SandboxProvider["executeIsolatedPython"]>>;
let start: Mock<SandboxProvider["start"]>;
let remove: Mock<SandboxProvider["delete"]>;

suite("isolated Python: real Broker / isolated PostgreSQL / controlled provider and object store", () => {
  beforeEach(() => {
    vi.clearAllMocks(); transport.bodies.clear();
    Object.assign(computeBrokerConfig.tencent, { apiKey: "synthetic-not-a-key", domain: "synthetic.invalid", allInOneTool: "synthetic-aio" });
    start = vi.fn(async (input: any) => ({ id: input.sandboxLeaseId, provider: "tencent" as const, providerSandboxId: `synthetic-${input.sandboxLeaseId}`, runnerType: "docker" as const, leaseId: input.sandboxLeaseId, containerId: `synthetic-${input.sandboxLeaseId}`, containerName: `synthetic-${input.sandboxLeaseId}`, sessionRoot: "/home/user/workspace" }));
    dispatch = vi.fn(async (input: any) => { await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); return receipt; });
    remove = vi.fn(async () => undefined);
    provider = { kind: "tencent", start, execute: vi.fn(async () => { throw new Error("raw_execution_forbidden"); }), executeIsolatedPython: dispatch, delete: remove, stop: vi.fn() };
    vi.spyOn(leases, "createConfiguredProviderRegistry").mockReturnValue({ create: async () => provider, configured: () => true, resolveLegacyProvider: () => "tencent" } as never);
    vi.spyOn(artifacts, "persistExecutionArtifacts").mockImplementation(async input => {
      const result = [];
      if (input.stdout) result.push(await saveArtifact(input, "STDOUT", input.stdout));
      if (input.stderr) result.push(await saveArtifact(input, "STDERR", input.stderr));
      return result;
    });
    vi.spyOn(artifacts, "persistFileArtifact").mockImplementation(input => saveArtifact(input, "FILE", input.content));
  });
  afterEach(() => { vi.restoreAllMocks(); Object.assign(computeBrokerConfig.tencent, configBefore); });
  afterAll(async () => { await Promise.all([prisma.$disconnect(), brokerDb.$disconnect()]); });

  it("D09: replays a logical action without provider calls, artifacts or charges across a worker restart", async () => {
    const f = await fixture(); const request = { ...f.request({ outputFileName: "result.txt" }), logicalAction: { version: 1 as const, ordinal: 1 } };
    const first = await executeTool(f.sessionId, request); expect(first.outcome).toBe("completed"); expect(first.execution.id).toMatch(/^pa_/);
    const original = await prisma.toolExecution.findUniqueOrThrow({ where: { id: first.execution.id } });
    expect(original.actionIdentity).toMatchObject({ version: 1, ordinal: 1, originMessageId: f.messageId, generationRunId: f.runId, effect: "write" });
    const costs = await prisma.ledgerEntry.count({ where: { toolExecutionId: first.execution.id } });
    // A crash after the completion commit but before caching the response must
    // reconstruct the existing receipt, never submit again.
    await prisma.toolExecution.update({ where: { id: original.id }, data: { responseSnapshot: Prisma.DbNull } });
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { requestedAnswerFormat: "brief" } } });
    expect(await executeTool(f.sessionId, request)).toMatchObject({ outcome: "completed", execution: { id: original.id } });
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    expect(await executeTool(f.sessionId, { ...request, generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 2 } })).toMatchObject({ outcome: "completed" });
    expect(dispatch).toHaveBeenCalledOnce(); expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: original.id } })).toBe(costs);
    expect(await prisma.artifact.count({ where: { toolExecutionId: original.id } })).toBe(2);
    await expect(executeTool(f.sessionId, { ...request, isolatedPython: { ...request.isolatedPython, source: "print(999)" }, generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 2 } })).rejects.toThrow("logical_action_payload_changed");
    await expect(executeTool(f.sessionId, { ...request, logicalAction: { version: 1, ordinal: 2 }, generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 2 } })).rejects.toThrow("recovery_checkpoint_required");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("D09: two simultaneous replays admit only one execution", async () => {
    const f = await fixture(); const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 1 } };
    let signalStarted!: () => void; const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    dispatch.mockImplementationOnce(async input => { await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); signalStarted(); await waiting; return receipt; });
    const first = executeTool(f.sessionId, request); await started;
    try { await expect(executeTool(f.sessionId, request)).rejects.toThrow("logical_action_in_progress"); }
    finally { release(); }
    const completed = await first; expect(completed.outcome).toBe("completed"); expect(dispatch).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
    expect(await prisma.toolExecution.count({ where: { sessionId: f.sessionId } })).toBe(1);
  });
  it("D09: separate logical actions may have equal parameters, but a replay cannot fill a skipped earlier slot", async () => {
    const f = await fixture(); const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 2 } };
    const first = await executeTool(f.sessionId, request);
    await expect(executeTool(f.sessionId, { ...request, logicalAction: { version: 1, ordinal: 1 } })).rejects.toThrow("context_changed");
    expect(dispatch).toHaveBeenCalledOnce();
    const second = await executeTool(f.sessionId, { ...request, logicalAction: { version: 1, ordinal: 3 } });
    expect(second.outcome).toBe("completed"); expect(second.execution.id).not.toBe(first.execution.id); expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("D09: one pending approval survives replays and presentation changes, with its action identity unchanged", async () => {
    const f = await fixture("ASK"); const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 1 } };
    const first = await executeTool(f.sessionId, request); expect(first.outcome).toBe("pending_approval");
    const action = await prisma.toolExecution.findUniqueOrThrow({ where: { id: first.execution.id } });
    expect(await executeTool(f.sessionId, request)).toMatchObject({ outcome: "pending_approval", approvalRequest: { id: first.approvalRequest!.id } });
    expect(await prisma.approvalRequest.count({ where: { sessionId: f.sessionId } })).toBe(1); expect(dispatch).not.toHaveBeenCalled();
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { requestedAnswerFormat: "table" }, status: "WAITING_APPROVAL" } });
    await resolveApproval(first.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" }); await processNextApprovedExecution();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: "SUCCEEDED", actionIdentity: action.actionIdentity });
    expect(await executeTool(f.sessionId, request)).toMatchObject({ outcome: "completed", execution: { id: action.id } }); expect(dispatch).toHaveBeenCalledOnce();
    await expect(prisma.toolExecution.update({ where: { id: action.id }, data: { actionIdentity: { version: 1, ordinal: 99 } } })).rejects.toThrow("immutable");
  });

  it("D09: a new message allows the same parameters; replaying the original event in another run does not", async () => {
    const f = await fixture(); const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 1 } };
    const first = await executeTool(f.sessionId, request);
    const replay = await nextIntent(f, true);
    await expect(executeTool(replay.sessionId, { ...request, generationWorkLease: replay.lease })).rejects.toThrow("logical_action_context_changed");
    await expect(executeTool(replay.sessionId, { ...request, logicalAction: { version: 1, ordinal: 2 }, generationWorkLease: replay.lease })).rejects.toThrow("origin_already_processed");
    const next = await nextIntent(f);
    const second = await executeTool(next.sessionId, { ...request, generationWorkLease: next.lease });
    expect(second.outcome).toBe("completed"); expect(second.execution.id).not.toBe(first.execution.id); expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("D09: an unknown prior submission survives a new run/key; read admission remains available", async () => {
    const f = await fixture(); const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 1 } };
    dispatch.mockImplementationOnce(async input => { await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); throw new IsolatedPythonExecutionError("isolated_python_outcome_unknown", true, "/tmp/delegate-bootstrap-synthetic"); });
    const first = await executeTool(f.sessionId, request); expect(first.execution.transportOutcome).toBe("outcome_unknown");
    expect(await executeTool(f.sessionId, request)).toMatchObject({ execution: { id: first.execution.id, transportOutcome: "outcome_unknown" } });
    const next = await nextIntent(f);
    await expect(executeTool(next.sessionId, { ...request, generationWorkLease: next.lease })).rejects.toThrow("previous_unresolved");
    await expect(executeTool(f.sessionId, { ...request, logicalAction: { version: 1, ordinal: 2 } })).rejects.toThrow("previous_unresolved");
    expect(dispatch).toHaveBeenCalledOnce();
    await executeTool(next.sessionId, { capability: "read", subagentId: "compute-agent", path: "/workspace/result.txt", logicalAction: { version: 1, ordinal: 1 }, generationWorkLease: next.lease });
    expect(provider.execute).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce(); // controlled read runner deliberately fails, but is admitted
  });

  it("D09: new Pi runs cannot omit action identity or use a stale worker lease", async () => {
    const f = await fixture(); await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { piActionIdentityVersion: 1 } } });
    await expect(executeTool(f.sessionId, f.request())).rejects.toThrow("identity_required");
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    await expect(executeTool(f.sessionId, { ...f.request(), logicalAction: { version: 1, ordinal: 1 } })).rejects.toThrow("work_lease_lost");
    expect(dispatch).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(await prisma.toolExecution.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });
  it("D09: a real approved continuation permits the next action under the resumed worker lease", async () => {
    const f = await fixture("ASK"); const session = await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } });
    const guard = await createAgentContextAuthorization({ runId: f.runId, outboxId: f.outboxId, leaseAttempt: 1, representativeId: f.repId,
      representativeVersionId: session.representativeVersionId, conversationId: session.conversationId!, contactId: session.contactId,
      audienceIdentityId: f.audienceId, sourceChannel: "web", userText: "Synthetic calculation", history: [], restoring: false });
    const request = { ...f.request(), logicalAction: { version: 1 as const, ordinal: 1 } };
    const first = await executeTool(f.sessionId, request);
    await resolveApproval(first.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" }); await processNextApprovedExecution();
    expect(dispatch).toHaveBeenCalledOnce();
    const stored = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { ...stored.contextSnapshot as object,
      piApprovalContinuation: { version: 2, status: "completed", approvalId: first.approvalRequest!.id,
        checkpoint: { actionIdentityVersion: 1, nextActionOrdinal: 2, contextAuthorization: guard.snapshot(), replaySourcesTracked: true } } } } });
    await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    const second = await executeTool(f.sessionId, { ...request, logicalAction: { version: 1, ordinal: 2 }, generationWorkLease: { outboxId: f.outboxId, leaseAttempt: 2 } });
    expect(second.outcome).toBe("pending_approval"); expect(second.execution.id).not.toBe(first.execution.id); expect(dispatch).toHaveBeenCalledOnce();
    await resolveApproval(second.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" }); await processNextApprovedExecution();
    expect(dispatch).toHaveBeenCalledTimes(2); expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: second.execution.id } })).toMatchObject({ status: "SUCCEEDED" });
  });

  it("uses a fresh exclusive lease, delivers verified bytes and replays without execution or billing duplication", async () => {
    const f = await fixture(); const request = f.request({ outputFileName: "result.txt" });
    expect(await getCodeExecutionPreflight(f.sessionId)).toMatchObject({ available: true, profileId: receipt.profile });
    const result = await executeTool(f.sessionId, request);
    expect(result.outcome).toBe("completed"); expect(dispatch).toHaveBeenCalledOnce(); expect(provider.execute).not.toHaveBeenCalled();
    const artifact = result.artifacts.find(item => item.kind === "file")!;
    const download = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: artifact.id, audienceIdentityId: f.audienceId }, { recordDownload: false });
    expect(download?.fileName).toBe("result.txt"); expect(download?.buffer.toString()).toBe("1012\n");
    expect(await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: artifact.id, audienceIdentityId: "other" }, { recordDownload: false })).toBeNull();
    const ledgerCount = await prisma.ledgerEntry.count({ where: { toolExecutionId: result.execution.id } });
    expect(ledgerCount).toBe(2);
    expect(await executeTool(f.sessionId, request)).toMatchObject({ outcome: "completed", execution: { id: result.execution.id } });
    expect(dispatch).toHaveBeenCalledOnce(); expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: result.execution.id } })).toBe(ledgerCount);
    expect((await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } })).sandboxLeaseId).toBeNull();
    expect(await prisma.sandboxLease.findFirstOrThrow({ where: { sandboxIdentity: { representativeId: f.repId } } })).toMatchObject({ status: "ARCHIVED" });
    expect(remove).toHaveBeenCalledOnce();
    await executeTool(f.sessionId, f.request({ actionKey: "explicit-new-call", outputFileName: "result.txt" }));
    expect(dispatch).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledTimes(2);
  });

  it("preserves an old sandbox and transfers only current approved input bytes", async () => {
    const f = await fixture();
    const session = await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } });
    const old = await leases.ensureUserSandboxLease({ session, networkMode: "full", filesystemMode: "ephemeral_full", providerFactory: async () => provider, selectProviderForNewIdentity: async () => ({ providerKind: "tencent", decisionSource: "legacy" }) });
    const bytes = Buffer.from("test");
    const a = await prisma.messageAttachment.create({ data: { messageId: f.messageId, fileName: "input.txt", sizeBytes: bytes.length, checksum: hash(bytes), objectKey: "synthetic-input" } });
    const fileName = `attachment-${a.id}.txt`;
    transport.loadInputs.mockResolvedValueOnce([{ id: a.id, sandboxFileName: fileName, sizeBytes: bytes.length, checksum: hash(bytes), base64: bytes.toString("base64") }]);
    const result = await executeTool(f.sessionId, f.request({ inputs: [{ attachmentId: a.id, fileName, sizeBytes: bytes.length, checksum: hash(bytes) }] }));
    expect(result.outcome).toBe("completed");
    expect(dispatch.mock.calls[0]![0].inputs).toEqual([{ fileName, content: bytes }]);
    expect(dispatch.mock.calls[0]![0].lease.id).not.toBe(old.lease.id);
    expect(await prisma.sandboxLease.findUniqueOrThrow({ where: { id: old.lease.id } })).toMatchObject({ status: "RUNNING" });
    expect(remove.mock.calls[0]![0].lease.id).not.toBe(old.lease.id);
  });

  it("blocks cross-run attachment references before reading storage or creating a provider", async () => {
    const f = await fixture(); const other = await fixture();
    const a = await prisma.messageAttachment.create({ data: { messageId: other.messageId, fileName: "input.txt", sizeBytes: 4, checksum: hash("test"), objectKey: "synthetic-other" } });
    await expect(executeTool(f.sessionId, f.request({ inputs: [{ attachmentId: a.id, fileName: `attachment-${a.id}.txt`, sizeBytes: 4, checksum: hash("test") }] }))).rejects.toThrow("changed_or_unavailable");
    expect(start).not.toHaveBeenCalled(); expect(transport.loadInputs).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.DELEGATE_RUN_CLOUD_BOUNDARY_PROBE !== "1")("real Tencent AIO through worker HTTP Broker, immutable CSV input, artifact persistence and audience download", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const { parse: parseEnv } = createRequire(resolve(root, "apps/compute-broker/package.json"))("dotenv") as { parse: (input: Buffer) => Record<string, string> };
    const env = parseEnv(await readFile(resolve(root, ".env")));
    const apiKey = env.TENCENT_AGS_API_KEY?.trim(), allInOneTool = env.TENCENT_AGS_ALL_IN_ONE_TOOL?.trim();
    const domain = env.TENCENT_AGS_DOMAIN?.trim().replace(/^https?:\/\//u, "").replace(/\/$/u, "") || `${env.TENCENT_AGS_REGION?.trim()}.tencentags.com`;
    if (!apiKey || !allInOneTool || !domain.endsWith(".tencentags.com")) throw new Error("authorized_cloud_configuration_missing");
    Object.assign(computeBrokerConfig.tencent, { apiKey, domain, allInOneTool });
    const { TencentAgsxSandboxProvider, createTencentAgsxSdkClient } = await import("../../../apps/compute-broker/src/tencent-agsx-provider");
    let sdkDiagnostic: Record<string, unknown> | undefined;
    const client = createTencentAgsxSdkClient();
    const create = client.create.bind(client);
    client.create = async value => {
      try { return await create(value); }
      catch (error) {
        let message = error instanceof Error ? error.message : "non_error";
        for (const secret of Object.values(env).filter(value => value.length >= 4).sort((a,b) => b.length-a.length)) message = message.split(secret).join("[REDACTED]");
        sdkDiagnostic = { name: error instanceof Error ? error.name : "unknown", sanitizedMessage: message.slice(0, 250) };
        throw error;
      }
    };
    provider = new TencentAgsxSandboxProvider({ client, apiKey, domain, allInOneTool, sandboxTimeoutMs: 180000 });
    // Real artifact persistence and parsing, with an in-memory S3 transport.
    // No production bucket is accessed. Public audience download uses real DB ACL.
    vi.mocked(artifacts.persistExecutionArtifacts).mockRestore();
    vi.mocked(artifacts.persistFileArtifact).mockRestore();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command.constructor.name === "PutObjectCommand") { transport.bodies.set(command.input.Key, Buffer.from(command.input.Body)); return {}; }
      if (["HeadBucketCommand", "CreateBucketCommand"].includes(command.constructor.name)) return {};
      throw new Error("unexpected_synthetic_storage_operation");
    });
    const f = await fixture(); const bytes = Buffer.from("a,b\n1,2\n");
    const a = await prisma.messageAttachment.create({ data: { messageId: f.messageId, fileName: "input.csv", sizeBytes: bytes.length, checksum: hash(bytes), objectKey: "synthetic-cloud-input" } });
    const fileName = `attachment-${a.id}.csv`;
    transport.loadInputs.mockResolvedValue([{ id: a.id, fileName: "input.csv", sandboxFileName: fileName, sizeBytes: bytes.length, checksum: hash(bytes), base64: bytes.toString("base64") }]);
    const oldBrokerUrl = process.env.COMPUTE_BROKER_URL;
    const bridge = createServer(async (incoming, outgoing) => {
      try {
        if (incoming.headers.authorization !== `Bearer ${process.env.COMPUTE_BROKER_INTERNAL_TOKEN}`) { outgoing.writeHead(403).end(); return; }
        const segments = (incoming.url ?? "").split("/").filter(Boolean);
        const chunks = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const response = segments.at(-1) === "sessions" ? await createComputeSession(body)
          : segments.at(-1) === "code-preflight" ? await getCodeExecutionPreflight(segments.at(-2)!)
          : segments.at(-1) === "executions" ? await executeTool(segments.at(-2)!, body) : null;
        outgoing.writeHead(response ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(response));
      } catch { outgoing.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "synthetic_broker_failure" })); }
    });
    await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
    process.env.COMPUTE_BROKER_URL = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
    let passed = false;
    try {
      const { buildPiAdapters } = await import("../../../apps/conversation-worker/src/processor-pi");
      const storedSession = await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } });
      const attachments = [{ id: a.id, fileName: "input.csv", mimeType: "text/csv", sizeBytes: bytes.length }];
      const capabilities = buildPiAdapters({
        config: {} as never,
        item: { representativeSlug: f.slug, runId: f.runId, conversationId: storedSession.conversationId, contactId: storedSession.contactId,
          audienceIdentityId: f.audienceId, channel: "web", userText: "读取 CSV，在沙盒计算总和加1009，交付 result.txt", inputAttachments: attachments } as never,
        setup: { id: f.repId, compute: { enabled: true, baseImage: storedSession.baseImage }, skillPacks: [], humanInLoop: false } as never,
        authority: { mcpBindings: [], compute: { capabilityModes: { browser: "deny" } } } as never,
        leaseGuard: { confirmOwned: async () => undefined } as never, workLease: { outboxId: f.outboxId, leaseAttempt: 1 },
        computeAttachments: [], onMemoryUse: () => undefined, onHandoff: () => undefined, onPendingApproval: () => undefined,
        onCompute: () => undefined, onSandboxExecutor: () => undefined,
      });
      const result = await capabilities.sandbox!.execute({ language: "python", code: `import csv\nrows=list(csv.reader(open('/workspace/inputs/${fileName}')))\nprint(sum(int(v) for v in rows[1])+1009)`,
        attachmentIds: [a.id], expectedOutputs: ["result.txt"], timeoutMs: 5000,
        context: { traceId: "synthetic-cloud", runId: f.runId, sessionId: storedSession.conversationId!, timezone: "Asia/Shanghai", attachments, idempotencyKey: "synthetic-cloud-worker-call" }, signal: new AbortController().signal });
      expect(result.status).toBe("completed"); expect(result.authoritativeSummary).toBe("1012\n");
      const executionId = String(result.details?.executionId);
      expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: executionId } })).toMatchObject({ transportOutcome: "response_received", status: "SUCCEEDED" });
      const file = result.artifacts![0]!;
      const download = await getPublicConversationArtifactDownload({ representativeSlug: f.slug, artifactId: file.id, audienceIdentityId: f.audienceId }, { recordDownload: false });
      expect(download?.fileName).toBe("result.txt"); expect(download?.buffer.toString()).toBe("1012\n");
      expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: executionId } })).toBe(2);
      expect(await prisma.artifact.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ sha256: hash("1012\n"), sizeBytes: 5 });
      passed = true;
    } finally {
      if (oldBrokerUrl === undefined) delete process.env.COMPUTE_BROKER_URL; else process.env.COMPUTE_BROKER_URL = oldBrokerUrl;
      bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
      const records = await prisma.sandboxLease.findMany({ where: { sandboxIdentity: { representativeId: f.repId } } });
      for (const record of records) if (record.status !== "ARCHIVED") await retirePythonLease(record.id).catch(() => undefined);
      const finalRecords = await prisma.sandboxLease.findMany({ where: { sandboxIdentity: { representativeId: f.repId } } });
      const deleted = finalRecords.length > 0 && finalRecords.every(record => record.status === "ARCHIVED");
      await mkdir(resolve(root, ".local/agent-remediation"), { recursive: true });
      const operations = await prisma.sandboxProviderOperation.findMany({ where: { sandboxLeaseId: { in: finalRecords.map(record => record.id) } } });
      await writeFile(resolve(root, ".local/agent-remediation/d04b2-cloud-leases.json"), JSON.stringify({ leases: finalRecords.map(record => ({ providerSandboxId: record.providerSandboxId, status: record.status })), operations: operations.map(operation => ({ creationKey: operation.creationKey, state: operation.state, lastErrorCode: operation.lastErrorCode })) }), { mode: 0o600 });
      const safeState = finalRecords.map(record => ({ status: record.status, hasProviderHandle: Boolean(record.providerSandboxId), errorReason: record.errorReason }));
      const reportName = `cloud-broker-case-${Date.now()}.json`;
      await writeFile(resolve(root, "reports/agent-remediation/20260929-d04b2", reportName), JSON.stringify({ completedAt: new Date().toISOString(), passed, deleted, instances: finalRecords.length, safeState, sdkDiagnostic, providerOperations: operations.map(operation => ({ state: operation.state, error: operation.lastErrorCode })), environment: "real worker adapter and HTTP client; test HTTP bridge into real Broker; real Tencent AIO; isolated PostgreSQL; real artifact persistence; controlled S3 transport; real audience download service", applicationDatabaseAccessed: false, businessMessagesSent: false }, null, 2));
      expect(deleted).toBe(true);
    }
  }, 90000);

  it("records one action for concurrent replay", async () => {
    const f = await fixture(); const values = await Promise.allSettled([executeTool(f.sessionId, f.request()), executeTool(f.sessionId, f.request())]);
    expect(values.some(value => value.status === "fulfilled")).toBe(true); expect(dispatch).toHaveBeenCalledOnce();
    expect(await prisma.toolExecution.count({ where: { sessionId: f.sessionId } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { sessionId: f.sessionId } })).toBe(2);
  });

  it("binds the full action before approval and does not upload or read bodies while waiting", async () => {
    const f = await fixture("ASK"); const result = await executeTool(f.sessionId, f.request({ outputFileName: "result.txt" }));
    expect(result.outcome).toBe("pending_approval"); expect(start).not.toHaveBeenCalled(); expect(transport.loadInputs).not.toHaveBeenCalled();
    const stored = await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } });
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: result.approvalRequest!.id } });
    expect(approval.requestPayloadHash).toBe(stored.requestPayloadHash);
    await expect(executeTool(f.sessionId, f.request({ source: "print(999)", outputFileName: "result.txt" }))).rejects.toThrow("parameters_changed");
    await expect(executeTool(f.sessionId, f.request({ outputFileName: "other.txt" }))).rejects.toThrow("parameters_changed");
    // Presentation-only changes live outside the action payload.
    await prisma.generationRun.update({ where: { id: f.runId }, data: { contextSnapshot: { requestedAnswerFormat: "brief" }, status: "WAITING_APPROVAL" } });
    await resolveApproval(approval.id, { resolution: "approved", resolvedBy: "synthetic-owner" });
    await processNextApprovedExecution();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: stored.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await prisma.artifact.count({ where: { toolExecutionId: stored.id, kind: "FILE" } })).toBe(1);
    const continuation = transport.finalize.mock.calls.at(-1)![0];
    expect(continuation).toMatchObject({ outcome: "completed", artifacts: expect.arrayContaining([expect.objectContaining({ kind: "file", fileName: "result.txt" })]) });
    const { loadApprovedToolResult } = await import("../../../apps/conversation-worker/src/processor-pi");
    const delivered = await loadApprovedToolResult({ generationRunId: f.runId, representativeSlug: f.slug, audienceIdentityId: f.audienceId, approvalId: approval.id,
      resultStatus: "completed", artifacts: continuation.artifacts, computeAttachments: [] });
    expect(delivered.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ fileName: "result.txt" })]));
  });

  it("honors separate write approval for an otherwise allowed Python action", async () => {
    const f = await fixture("ALLOW", "ASK");
    expect((await executeTool(f.sessionId, f.request({ outputFileName: "result.txt" }))).outcome).toBe("pending_approval"); expect(start).not.toHaveBeenCalled();
  });

  it.each(["input", "source", "expiry", "cancel"])("does not dispatch after approval when %s changes", async change => {
    const f = await fixture("ASK");
    const attachment = await prisma.messageAttachment.create({ data: { messageId: f.messageId, fileName: "input.txt", sizeBytes: 4, checksum: hash("test"), objectKey: "synthetic-input" } });
    const inputs = [{ attachmentId: attachment.id, fileName: `attachment-${attachment.id}.txt`, sizeBytes: 4, checksum: hash("test") }];
    const result = await executeTool(f.sessionId, f.request({ inputs }));
    await resolveApproval(result.approvalRequest!.id, { resolution: "approved", resolvedBy: "synthetic-owner" });
    if (change === "input") await prisma.messageAttachment.update({ where: { id: attachment.id }, data: { checksum: hash("else") } });
    if (change === "source") {
      const record = await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } }); const payload = JSON.parse(record.requestPayload as string); payload.isolatedPython.source = "print(999)";
      await prisma.toolExecution.update({ where: { id: record.id }, data: { requestPayload: JSON.stringify(payload) } });
    }
    if (change === "expiry") await prisma.approvalRequest.update({ where: { id: result.approvalRequest!.id }, data: { expiresAt: new Date(0) } });
    if (change === "cancel") await prisma.generationRun.update({ where: { id: f.runId }, data: { status: "CANCELED" } });
    await processNextApprovedExecution(); expect(dispatch).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(transport.loadInputs).not.toHaveBeenCalled();
    expect((await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } })).status).not.toBe("SUCCEEDED");
    expect(await prisma.artifact.count({ where: { toolExecutionId: result.execution.id } })).toBe(0);
  });

  it("rejects expired generation work ownership before recording an action", async () => {
    const f = await fixture(); await prisma.outboxEvent.update({ where: { id: f.outboxId }, data: { attemptCount: 2 } });
    await expect(executeTool(f.sessionId, f.request())).rejects.toThrow("work_lease_lost"); expect(dispatch).not.toHaveBeenCalled();
    expect(await prisma.toolExecution.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });

  it("rechecks a permission revoked during provider preparation before admitting the program", async () => {
    const f = await fixture(); let admitted = 0;
    dispatch.mockImplementation(async input => {
      await prisma.representative.update({ where: { id: f.repId }, data: { computeEnabled: false } });
      await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); admitted += 1; return receipt;
    });
    const result = await executeTool(f.sessionId, f.request());
    expect(result.outcome).toBe("failed"); expect(result.execution.transportOutcome).toBe("confirmed_not_sent");
    expect(admitted).toBe(0); expect(remove).toHaveBeenCalledOnce();
    expect(await prisma.artifact.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });

  it("keeps lost responses unknown and does not replay under a different call id", async () => {
    const f = await fixture(); dispatch.mockImplementation(async (input: any) => { await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); throw new IsolatedPythonExecutionError("synthetic_lost_response", true, "/tmp/delegate-bootstrap-synthetic"); });
    const result = await executeTool(f.sessionId, f.request());
    expect(result.execution.transportOutcome).toBe("outcome_unknown"); expect(result.outcome).toBe("failed");
    await executeTool(f.sessionId, f.request());
    await expect(executeTool(f.sessionId, f.request({ actionKey: "automatic-retry" }))).rejects.toThrow("previous_action_unresolved");
    expect(dispatch).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
    expect(await prisma.ledgerEntry.aggregate({ where: { sessionId: f.sessionId }, _sum: { costCents: true } })).toMatchObject({ _sum: { costCents: 0 } });
  });

  it("cancels an active provider call when the authoritative run is canceled", async () => {
    const f = await fixture(); dispatch.mockImplementation(async (input: any) => {
      await input.beforeDispatch("/tmp/delegate-bootstrap-synthetic"); await prisma.generationRun.update({ where: { id: f.runId }, data: { status: "CANCELED" } });
      await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { ...receipt, termination: "cancelled", exitCode: null, stdout: "" };
    });
    const result = await executeTool(f.sessionId, f.request()); expect(result.outcome).toBe("failed"); expect(dispatch).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
    expect(result.execution.status).toBe("canceled");
    expect(await prisma.artifact.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });

  it.each([false, true])("quarantines stale executions without redispatching (logical=%s)", async logical => {
    const f = await fixture(); remove.mockRejectedValueOnce(new Error("synthetic_delete_lost"));
    const result = await executeTool(f.sessionId, { ...f.request(), ...(logical ? { logicalAction: { version: 1, ordinal: 1 } } : {}) });
    const lease = await prisma.sandboxLease.findFirstOrThrow({ where: { sandboxIdentity: { representativeId: f.repId } } });
    expect(lease.status).toBe("ERROR");
    await prisma.sandboxLease.update({ where: { id: lease.id }, data: { updatedAt: new Date(0) } });
    await prisma.toolExecution.update({ where: { id: result.execution.id }, data: { status: "RUNNING", startedAt: new Date(0), executionLeaseToken: "stale-synthetic" } });
    await reconcilePythonExecutions(); expect(dispatch).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledTimes(2);
    expect(await prisma.toolExecution.findUniqueOrThrow({ where: { id: result.execution.id } })).toMatchObject({ status: "FAILED", transportOutcome: "outcome_unknown", executionLeaseToken: null });
    expect(await prisma.sandboxLease.findUniqueOrThrow({ where: { id: lease.id } })).toMatchObject({ status: "ARCHIVED" });
  });
});

async function saveArtifact(input: any, kind: "FILE" | "STDOUT" | "STDERR", text: string) {
  const id = `synthetic-${randomUUID()}`; transport.bodies.set(id, Buffer.from(text));
  return prisma.artifact.create({ data: { id, representativeId: input.representativeId, contactId: input.contactId, conversationId: input.conversationId, sessionId: input.sessionId, toolExecutionId: input.executionId,
    kind, bucket: "synthetic", objectKey: id, mimeType: "text/plain; charset=utf-8", sizeBytes: Buffer.byteLength(text), sha256: hash(text), retentionUntil: new Date(Date.now() + 3600000) } });
}

async function fixture(execMode: "ALLOW" | "ASK" = "ALLOW", writeMode: "ALLOW" | "ASK" = "ALLOW") {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic Python owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `isolated-python-${randomUUID()}`, displayName: "Synthetic", roleSummary: "Test", tone: "neutral", languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Test", allowedSkills: [], actionGate: {}, computeEnabled: true, computeDefaultPolicyMode: "ALLOW", computeNetworkMode: "FULL", computeFilesystemMode: "EPHEMERAL_FULL", computeAutoApproveTokenLimit: 10000 } });
  await prisma.capabilityPolicyProfile.create({ data: { representativeId: rep.id, name: "Synthetic", isDefault: true, defaultDecision: "ALLOW", networkMode: "FULL", filesystemMode: "EPHEMERAL_FULL", rules: { create: [{ id: `${rep.id}_exec_owner_mode`, capability: "EXEC", decision: execMode }, { id: `${rep.id}_write_owner_mode`, capability: "WRITE", decision: writeMode }] } } });
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, snapshot: { compute: { enabled: true, defaultPolicyMode: "allow", baseImage: rep.computeBaseImage, maxSessionMinutes: 15, autoApproveTokenLimit: 10000, artifactRetentionDays: 14, networkMode: "full", networkAllowlist: [], filesystemMode: "ephemeral_full", capabilityModes: { exec: execMode.toLowerCase(), read: "allow", write: writeMode.toLowerCase(), process: "allow", browser: "allow", mcp: "allow" } } } } });
  await prisma.representative.update({ where: { id: rep.id }, data: { activeVersionId: version.id } });
  const audience = await prisma.audienceIdentity.create({ data: { audienceKey: randomUUID(), status: "REGISTERED" } });
  const contact = await prisma.contact.create({ data: { representativeId: rep.id, audienceIdentityId: audience.id, sourceChannel: "web" } });
  const conversation = await prisma.conversation.create({ data: { representativeId: rep.id, contactId: contact.id, audienceIdentityId: audience.id, channel: "PRIVATE_CHAT", sourceChannel: "web" } });
  await prisma.conversationEpisode.create({ data: { conversationId: conversation.id, sequence: 1, representativeVersionId: version.id } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, senderType: "AUDIENCE", text: "Synthetic calculation" } });
  const run = await prisma.generationRun.create({ data: { conversationId: conversation.id, inputMessageId: message.id, representativeVersionId: version.id, idempotencyKey: randomUUID(), status: "PROCESSING", runtimePolicySnapshot: { billingMode: "free" } } });
  const outbox = await prisma.outboxEvent.create({ data: { aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", payload: {}, status: "PROCESSING", attemptCount: 1, availableAt: new Date(Date.now() + 300000), idempotencyKey: randomUUID() } });
  const session = await createComputeSession({ representativeId: rep.id, requestedBy: "audience", contactId: contact.id, conversationId: conversation.id, generationRunId: run.id, subagentId: "compute-agent", requestedCapabilities: ["exec", "write"], reason: "synthetic-test" });
  return { repId: rep.id, slug: rep.slug, sessionId: session.session.id, audienceId: audience.id, runId: run.id, messageId: message.id, outboxId: outbox.id,
    request: (changes: Record<string, unknown> = {}) => ({ capability: "exec", subagentId: "compute-agent", generationWorkLease: { outboxId: outbox.id, leaseAttempt: 1 },
      isolatedPython: { profileId: receipt.profile, actionKey: "call-1", source: "print(1+2+1009)", timeoutMs: 1000, inputs: [], ...changes } }) };
}

async function nextIntent(f: Awaited<ReturnType<typeof fixture>>, reuseOriginalMessage = false) {
  const previous = await prisma.computeSession.findUniqueOrThrow({ where: { id: f.sessionId } });
  const messageId = reuseOriginalMessage ? f.messageId : (await prisma.message.create({ data: {
    conversationId: previous.conversationId!, senderType: "AUDIENCE", text: "Synthetic: explicitly execute the same request once more",
  } })).id;
  const run = await prisma.generationRun.create({ data: { conversationId: previous.conversationId!, inputMessageId: messageId,
    representativeVersionId: previous.representativeVersionId, idempotencyKey: randomUUID(), status: "PROCESSING", runtimePolicySnapshot: { billingMode: "free" } } });
  const outbox = await prisma.outboxEvent.create({ data: { aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", payload: {},
    status: "PROCESSING", attemptCount: 1, availableAt: new Date(Date.now()+300000), idempotencyKey: randomUUID() } });
  const session = await createComputeSession({ representativeId: f.repId, requestedBy: "audience", contactId: previous.contactId!, conversationId: previous.conversationId!,
    generationRunId: run.id, subagentId: "compute-agent", requestedCapabilities: ["exec", "read"], reason: "synthetic-new-intent" });
  return { sessionId: session.session.id, lease: { outboxId: outbox.id, leaseAttempt: 1 }, runId: run.id };
}
