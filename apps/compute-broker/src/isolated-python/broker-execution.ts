import type { IsolatedPythonRequest } from "@delegate/compute-protocol";
import { validateAgentTextOutputContent, validateAgentTextOutputRequest } from "@delegate/runtime";
import { persistExecutionArtifacts, persistFileArtifact } from "../artifacts";
import { computeBrokerConfig } from "../config";
import { selectProviderForNewComputeIdentity } from "../leases";
import type { loadSessionPolicyContext } from "../policy";
import { prisma } from "../prisma";
import { createConfiguredProviderRegistry, ensureUserSandboxLease } from "../sandbox-leases";
import { SessionError } from "../session-error";
import { loadVerifiedPythonInputs, verifyPythonInputManifest } from "./request";
import { IsolatedPythonExecutionError } from "./transport";

type Context = Awaited<ReturnType<typeof loadSessionPolicyContext>>;
const PROFILE = "delegate.aio.single-python.v1";

export async function retirePythonLease(leaseId: string) {
  const lease = await prisma.sandboxLease.findUnique({ where: { id: leaseId } });
  if (!lease || !lease.baseImage.startsWith(PROFILE + ":") || lease.provider !== "TENCENT") throw new Error("isolated_python_lease_mismatch");
  if (lease.status === "ARCHIVED") return;
  await prisma.sandboxLease.update({ where: { id: leaseId }, data: { status: "STOPPING" } });
  try {
    if (lease.providerSandboxId) {
      const provider = await createConfiguredProviderRegistry().create("tencent");
      await provider.delete({ sessionId: lease.id, lease: {
        id: lease.id, provider: "tencent", providerSandboxId: lease.providerSandboxId,
        runnerType: "docker", leaseId: lease.runnerLeaseId ?? lease.id,
        containerId: lease.containerId, containerName: lease.containerId,
        sessionRoot: lease.sessionRoot ?? "/home/user/workspace",
      } });
    } else {
      // Unbound create is handled by the existing provider-operation quarantine;
      // absence of a handle is not proof that the external create did not occur.
      throw new Error("isolated_python_lease_unbound");
    }
    await prisma.sandboxLease.update({ where: { id: leaseId }, data: { status: "ARCHIVED", stoppedAt: new Date(), errorReason: null } });
  } catch {
    await prisma.sandboxLease.update({ where: { id: leaseId }, data: { status: "ERROR", errorReason: "isolated_python_cleanup_pending" } });
    throw new Error("isolated_python_cleanup_pending");
  }
}

export async function runBrokerPythonExecution(input: {
  context: Context; request: IsolatedPythonRequest; executionId: string; executionLeaseToken: string;
  assertCurrentPermission: () => Promise<void>;
}) {
  const { request } = input;
  const started = Date.now();
  const controller = new AbortController();
  let leaseId: string | undefined;
  let submitted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingCheck: Promise<void> | undefined;
  const assertLive = async () => {
    const execution = await prisma.toolExecution.findUnique({ where: { id: input.executionId }, include: { session: { select: { generationRun: { select: { status: true } } } } } });
    if (execution?.status !== "RUNNING" || execution.executionLeaseToken !== input.executionLeaseToken
      || !["PROCESSING", "WAITING_APPROVAL"].includes(execution.session?.generationRun?.status ?? "")) {
      throw new SessionError(409, "isolated_python_action_no_longer_active");
    }
    if (execution.approvalRequestId) {
      const approval = await prisma.approvalRequest.findUnique({ where: { id: execution.approvalRequestId } });
      if (approval?.status !== "APPROVED" || approval.toolExecutionId !== execution.id
        || !approval.expiresAt || approval.expiresAt <= new Date()
        || approval.requestPayloadHash !== execution.requestPayloadHash) throw new SessionError(409, "isolated_python_approval_invalid");
    }
    await input.assertCurrentPermission();
  };
  const watch = () => {
    timer = setTimeout(() => {
      pendingCheck = assertLive().catch(() => { controller.abort(); });
      void pendingCheck.finally(() => { if (!controller.signal.aborted) watch(); });
    }, 250);
    timer.unref();
  };
  try {
    await assertLive();
    const loaded = await loadVerifiedPythonInputs(input.context.session.generationRunId!, request);
    await assertLive();
    const registry = createConfiguredProviderRegistry();
    const leased = await ensureUserSandboxLease({
      session: input.context.session,
      // PUBLIC instance egress; guest Python is independently offline. This
      // does not expose a network-capable code interface to the Agent.
      networkMode: "full", filesystemMode: "ephemeral_full",
      hostWorkspaceRoot: computeBrokerConfig.hostWorkspaceRoot,
      providerFactory: kind => registry.create(kind),
      selectProviderForNewIdentity: () => selectProviderForNewComputeIdentity(input.context.session, registry),
      exclusivePythonExecution: { id: input.executionId, token: input.executionLeaseToken },
    });
    leaseId = leased.lease.id;
    if (leased.providerLease.provider !== "tencent") throw new Error("isolated_python_provider_unavailable");
    const provider = await registry.create("tencent");
    if (!provider.executeIsolatedPython) throw new Error("isolated_python_adapter_unavailable");
    await assertLive();
    watch();
    const receipt = await provider.executeIsolatedPython({ lease: leased.providerLease, request, inputs: loaded, signal: controller.signal,
      beforeDispatch: async directory => {
        await verifyPythonInputManifest(input.context.session.generationRunId!, request);
        await assertLive();
        const fenced = await prisma.toolExecution.updateMany({
          where: { id: input.executionId, status: "RUNNING", executionLeaseToken: input.executionLeaseToken },
          data: { rawResultRef: JSON.stringify({ profileId: PROFILE, leaseId, controlDirectory: directory }), transportOutcome: "outcome_unknown" },
        });
        if (fenced.count !== 1) throw new SessionError(409, "compute_execution_claim_lost");
        submitted = true;
      },
    });
    await assertLive();
    if (controller.signal.aborted) throw new SessionError(409, "isolated_python_action_no_longer_active");
    const exitCode = receipt.termination === "exit" ? receipt.exitCode! : receipt.termination === "command_timeout" ? 124 : 137;
    const common = { representativeId: input.context.session.representativeId,
      representativeSlug: input.context.session.representative.slug,
      contactId: input.context.session.contactId, conversationId: input.context.session.conversationId,
      sessionId: input.context.session.id, executionId: input.executionId,
      retentionDays: input.context.profile.artifactRetentionDays };
    const artifacts = await persistExecutionArtifacts({ ...common, stdout: receipt.stdout, stderr: receipt.stderr });
    let failureSummary = receipt.termination === "exit" ? (exitCode === 0 ? "" : "isolated_python_program_failed") : `isolated_python_${receipt.termination}`;
    let finalExitCode = exitCode;
    if (request.outputFileName && exitCode === 0) {
      const output = validateAgentTextOutputRequest([request.outputFileName]);
      if (!output.ok || !output.file) throw new Error("isolated_python_output_invalid");
      const content = validateAgentTextOutputContent(output.file, receipt.stdout);
      if (content.ok) artifacts.unshift(await persistFileArtifact({ ...common, path: `outputs/${output.file.fileName}`, content: receipt.stdout }));
      else { finalExitCode = 1; failureSummary = content.reason; }
    }
    await assertLive();
    if (controller.signal.aborted) throw new SessionError(409, "isolated_python_action_no_longer_active");
    return { exitCode: finalExitCode, wallMs: Date.now() - started, bytesRead: Buffer.byteLength(receipt.stdout), artifacts,
      failureSummary, canceled: receipt.termination === "cancelled", transport: "docker" as const, transportOutcome: "response_received" as const };
  } catch (error) {
    const unknown = error instanceof IsolatedPythonExecutionError ? error.mayHaveExecuted : submitted;
    return { exitCode: 1, wallMs: Date.now() - started, bytesRead: 0, artifacts: [],
      canceled: controller.signal.aborted || (error instanceof SessionError && error.message === "isolated_python_action_no_longer_active"),
      failureSummary: controller.signal.aborted ? "isolated_python_cancelled" : unknown ? "isolated_python_outcome_unknown" : "isolated_python_not_submitted",
      transport: "docker" as const, transportOutcome: unknown ? "outcome_unknown" as const : "confirmed_not_sent" as const };
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    await pendingCheck;
    if (leaseId) await retirePythonLease(leaseId).catch(() => undefined);
  }
}

/** No replay. A lost worker cannot cause an old code action to run again. */
export async function reconcilePythonExecutions(now = new Date()) {
  const stale = await prisma.toolExecution.findMany({ where: {
    OR: [{ id: { startsWith: "py_" } }, { id: { startsWith: "pa_" }, requestedCommand: "isolated_python" }], status: "RUNNING", startedAt: { lt: new Date(now.getTime() - 120000) },
  }, take: 20 });
  for (const action of stale) {
    await prisma.toolExecution.updateMany({ where: { id: action.id, status: "RUNNING", executionLeaseToken: action.executionLeaseToken },
      data: { status: "FAILED", finishedAt: now, executionLeaseToken: null, transportOutcome: "outcome_unknown", semanticOutcome: "unknown" } });
  }
  const leases = await prisma.sandboxLease.findMany({ where: {
    baseImage: { startsWith: PROFILE + ":" }, provider: "TENCENT", status: { in: ["ERROR", "STOPPING", "RUNNING", "STOPPED"] },
    updatedAt: { lt: new Date(now.getTime() - 120000) },
  }, take: 20 });
  for (const lease of leases) await retirePythonLease(lease.id).catch(() => undefined);
  return { staleActions: stale.length, cleanupAttempts: leases.length };
}
