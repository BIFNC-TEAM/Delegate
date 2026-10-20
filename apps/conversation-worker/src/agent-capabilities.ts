import { createHash } from "node:crypto";

import {
  type PiCapabilityAdapters,
  type PiCapabilityResult,
  type PiSandboxAdapter
} from "@delegate/model-runtime";

import { agentTextFileOutput, agentTextFileOutputNotice } from "@delegate/domain";

import { validateAgentTextOutputContent, validateAgentTextOutputRequest } from "@delegate/runtime";

import {
  buildSandboxAttachmentFileName,
  buildSandboxAttachmentPath,
  createAudienceComputeSession,
  executeAudienceTool,
  getAudienceCodeExecutionPreflight,
  getPublicConversationArtifactDownload,
  getRepresentativeRuntimeAuthoritySnapshot,
  getRepresentativeRuntimeSetupSnapshot,
  isKnowledgeRetrievalServiceConfigured,
  loadGenerationInputAttachments,
  projectMcpModelInputSchema,
  recallRepresentativeContext,
  resolveServerOwnedMcpCapabilityPolicy
} from "@delegate/web-data";

import { AgentContextAuthorizationError } from "@delegate/runtime";

import type { ConversationWorkerConfig } from "./config";

import {
  resolveDeclaredAttachmentIds,
  validateDeclaredAttachmentRead
} from "./attachment-inputs";
import type { GenerationItem, GenerationLease, WorkLease } from "./generation-lease";
type PiSandboxExecute = PiSandboxAdapter["execute"];
export function buildAgentCapabilities(input: {
  config: ConversationWorkerConfig;
  item: GenerationItem;
  setup: NonNullable<Awaited<ReturnType<typeof getRepresentativeRuntimeSetupSnapshot>>>;
  leaseGuard: GenerationLease;
  workLease: WorkLease;
  authority: Awaited<ReturnType<typeof getRepresentativeRuntimeAuthoritySnapshot>>;
  computeAttachments: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
  onMemoryUse(runId: string | undefined, itemIds: string[]): void;
  registerKnowledgeSources?(runId: string, itemIds: string[]): Promise<void>;
  registerToolSource?(executionId: string): Promise<string | undefined>;
  onPendingApproval(approvalId: string): void;
}): PiCapabilityAdapters {
  const readCurrentArtifact = async (artifact: { id: string; sizeBytes: number }, executionId: string, maximumBytes: number) => {
    if(!input.item.audienceIdentityId || artifact.sizeBytes > maximumBytes) return null;
    const result = await getPublicConversationArtifactDownload({
      representativeSlug: input.item.representativeSlug,
      artifactId: artifact.id, audienceIdentityId: input.item.audienceIdentityId
    }, {
      recordDownload: false, maximumBytes,
      expectedOrigin: { generationRunId: input.item.runId, toolExecutionId: executionId }
    }).catch(() => null);
    return result && result.buffer.byteLength === artifact.sizeBytes ? result : null;
  };
  const readCurrentText = async (artifact: { id: string; sizeBytes: number }, executionId: string, maximumBytes: number) => {
    const downloaded = await readCurrentArtifact(artifact, executionId, maximumBytes);
    if(!downloaded || !(downloaded.mimeType.startsWith("text/") || downloaded.mimeType.includes("json"))) return null;
    const contentText = downloaded.buffer.toString("utf8");
    return downloaded.buffer.equals(Buffer.from(contentText, "utf8")) ? { contentText, truncated: false as const } : null;
  };
  // Catalog flags and execution result handling must share trusted behavior
  // classification. Approval is an independent owner policy, not a side effect.
  const resolveMcpToolPolicy = (
    binding: NonNullable<typeof input.authority>["mcpBindings"][number],
    toolName: string,
  ) => {
    const definition = binding.toolDefinitions?.find((tool) => tool.exactToolName === toolName);
    if(!definition || (binding.allowedToolNames.length > 0 && !binding.allowedToolNames.includes(toolName))) return null;
    return resolveServerOwnedMcpCapabilityPolicy({
      serverUrl: binding.serverUrl,
      transportKind: binding.transportKind,
      toolName,
      toolSchemaHash: definition.toolSchemaHash,
      inputSchema: definition.inputSchema,
    });
  };
  const executeMcp = async (request: {
    bindingId: string;
    bindingSlug: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
    estimatedTokens: number;
    readOnly: boolean;
    searchResults?: boolean;
    logicalAction?: { version: 1; ordinal: number };
  }) => {
    await input.leaseGuard.confirmOwned();
    if(!input.setup.compute.enabled) {
      return { status: "failed", text: "这个代表当前没有启用外部工具执行。", details: {} };
    }
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: input.workLease,
      subagentId: "compute-agent",
      requestedCapabilities: ["mcp"],
      reason: `${input.item.channel}:pi_mcp`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    const execution = await executeAudienceTool(session.session.id, {
      capability: "mcp",
      rejectApprovalWait: true,
      ...(request.logicalAction ? { logicalAction: request.logicalAction } : {}),
      bindingId: request.bindingId,
      bindingSlug: request.bindingSlug,
      toolName: request.toolName,
      toolArguments: request.toolArguments,
      estimatedTokens: request.estimatedTokens,
      hasPaidEntitlement: false,
      browserMode: "deterministic",
      maxSteps: 1,
      allowMutations: false,
      subagentId: "compute-agent",
      generationWorkLease: input.workLease,
    });
    input.leaseGuard.assertOwned();
    if(execution.outcome === "blocked") return {
      status: "denied", text: "服务端策略拒绝了本次执行。", observation: { state: "blocked" as const },
    };
    if(execution.outcome === "pending_approval") {
      if(!execution.approvalRequest) throw new Error("Compute approval response is missing.");
      input.onPendingApproval(execution.approvalRequest.id);
      return {
        status: "pending_approval",
        text: "外部工具调用正在等待代表所有者审批，尚未执行。",
        details: { approvalId: execution.approvalRequest.id },
        ...(request.searchResults ? { observation: { state: "unavailable" as const, evidenceKind: "search_results" as const } } : {}),
      };
    }
    const attachments = execution.artifacts.map((artifact) => ({
      fileName: resolvePublicArtifactFileName(artifact),
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      artifactId: artifact.id,
      url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
    }));
    const contextSourceRef = execution.outcome === "completed" ? await input.registerToolSource?.(execution.execution.id) : undefined;
    const verifiedResults = await Promise.all(execution.artifacts.slice(0, 8).map(artifact =>
      readCurrentText(artifact, execution.execution.id, 128_000)));
    const evidenceUnavailable = execution.artifacts.length > 8 || verifiedResults.some(result => !result);
    const authoritativeSummary = evidenceUnavailable ? "" : verifiedResults.map((result, index) => {
      const content = result?.contentText.trim(); const artifact = execution.artifacts[index]!;
      return content ? `${artifact.kind}:${artifact.id}\n${content}` : "";
    }).filter(Boolean).join("\n\n").slice(0, 40_000);
    const semanticOutcome = execution.execution?.semanticOutcome;
    const transportOutcome = execution.execution?.transportOutcome;
    const failureCode = safeCapabilityFailureCode(
      execution.blockReasonCode ?? execution.session.failureReason,
    );
    const completed = execution.outcome === "completed" && semanticOutcome !== "failed"
      && semanticOutcome !== "unknown" && semanticOutcome !== "partial";
    return {
      status: completed ? "completed" : "failed",
      ...(contextSourceRef ? { contextSourceRef } : {}),
      text: completed
        ? evidenceUnavailable ? "操作回执已保留，但当前无法核验结果的访问权限或完整性。不要重复执行，也不要声称结果已交付。"
          : authoritativeSummary || "外部工具已执行，未返回正文。"
        : transportOutcome === "outcome_unknown"
          ? "外部操作最终结果无法确认；系统不会自动重试或宣称完成。"
          : failureCode === "mcp_tool_schema_drift_replan_required"
            ? "MCP 工具目录已发生变化，本次调用在发送前安全停止；目录刷新后可以重新规划。"
            : "外部工具调用未满足业务成功条件。",
      details: {
        executionId: execution.execution.id,
        semanticOutcome: semanticOutcome ?? "unknown",
        transportOutcome: transportOutcome ?? "unknown",
        ...(failureCode ? { failureCode } : {}),
      },
      ...(semanticOutcome === "unknown" || transportOutcome === "outcome_unknown" ? { observation: { state: "unknown" as const } }
        : evidenceUnavailable ? { observation: { state: "blocked" as const } }
          : execution.execution.finishedAt ? {
            observation: {
              state: "available" as const, observedAt: execution.execution.finishedAt,
              ...(request.searchResults ? { evidenceKind: "search_results" as const } : {}),
            }
          } : {}),
      artifacts: request.readOnly || evidenceUnavailable ? [] : attachments.map((attachment) => ({
        id: attachment.artifactId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
      })),
      ...(!request.readOnly && authoritativeSummary ? { authoritativeSummary } : {}),
    };
  };

  const executeSandbox: PiSandboxExecute = async (request) => {
    request.signal.throwIfAborted();
    const effectiveRequest = request;
    if(effectiveRequest.language !== "python") return {
      status: "unavailable", text: "当前代码沙盒仅支持受限 Python；JavaScript、Shell 和长期进程暂不可用。",
      details: { reason: "isolated_python_language_required", deterministicFailure: true }, artifacts: [],
      recovery: { kind: "not_dispatched", reason: "isolated_python_language_required" },
    };
    const declaredRead = validateDeclaredAttachmentRead({
      code: effectiveRequest.code,
      attachmentIds: effectiveRequest.attachmentIds,
      attachments: input.item.inputAttachments.map((attachment) => ({
        ...attachment,
        uri: buildSandboxAttachmentPath(attachment.id, attachment.fileName),
      })),
    });
    if(!declaredRead.ok) {
      return {
        status: "failed",
        text: "沙盒请求没有声明并读取本轮附件的可信路径，未执行，也没有生成结果文件。",
        recovery: { kind: "not_dispatched", reason: declaredRead.reason },
        details: {
          reason: declaredRead.reason,
          deterministicFailure: true,
        },
        artifacts: [],
      };
    }
    const declaredAttachmentIds = resolveDeclaredAttachmentIds({
      code: effectiveRequest.code,
      attachmentIds: effectiveRequest.attachmentIds,
      attachments: input.item.inputAttachments.map((attachment) => ({
        ...attachment,
        uri: buildSandboxAttachmentPath(attachment.id, attachment.fileName),
      })),
    });
    const requestedOutputs = normalizeExpectedSandboxOutputs(
      effectiveRequest.expectedOutputs,
    );
    const outputRequest = validateAgentTextOutputRequest(requestedOutputs);
    if(!outputRequest.ok) {
      return { status: "failed", text: agentTextFileOutputNotice.zh, details: { reason: outputRequest.reason, deterministicFailure: true }, recovery: { kind: "not_dispatched", reason: outputRequest.reason }, artifacts: [] };
    }
    const outputFile = outputRequest.file;
    if(outputFile && !input.item.audienceIdentityId) {
      return { status: "failed", text: "当前会话缺少可验证的文件接收者身份，未执行文件生成。", details: { reason: "output_audience_identity_required" }, recovery: { kind: "not_dispatched", reason: "output_audience_identity_required" }, artifacts: [] };
    }
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id,
      contactId: input.item.contactId,
      conversationId: input.item.conversationId,
      generationRunId: input.item.runId,
      generationWorkLease: input.workLease,
      subagentId: "compute-agent",
      requestedCapabilities: requestedOutputs.length ? ["exec", "write"] : ["exec"],
      reason: `${input.item.channel}:pi_sandbox`,
      requestedBaseImage: input.setup.compute.baseImage,
    });
    request.signal.throwIfAborted();
    const common = {
      rejectApprovalWait: true,
      subagentId: "compute-agent" as const,
      generationWorkLease: input.workLease,
      estimatedTokens: 600 + 100 * Math.ceil(effectiveRequest.code.length / 256),
      hasPaidEntitlement: false,
      browserMode: "deterministic" as const,
      maxSteps: 1,
      allowMutations: false,
    };
    let codePreflight: Awaited<ReturnType<typeof getAudienceCodeExecutionPreflight>>;
    try {
      codePreflight = await getAudienceCodeExecutionPreflight(session.session.id);
    } catch {
      request.signal.throwIfAborted();
      // This is a read-only preflight failure, before the execution request.
      // It must not be mistaken for an already-submitted action of unknown outcome.
      return {
        status: "unavailable", text: "暂时无法完成代码执行预检。本次未提交脚本，也未向沙盒发送附件或生成文件。",
        details: { reason: "code_execution_preflight_unavailable", deterministicFailure: true },
        recovery: { kind: "not_dispatched", reason: "code_execution_preflight_unavailable" },
        observation: { state: "unavailable" as const, reason: "code_execution_preflight_unavailable" }, artifacts: [],
      };
    }
    request.signal.throwIfAborted();
    if(!codePreflight.available || codePreflight.profileId !== "delegate.aio.single-python.v1") {
      return {
        status: "unavailable",
        text: "当前会话没有可用的受限 Python 运行配置。本次未执行脚本，也未向沙盒发送附件或生成文件。",
        details: { reason: codePreflight.reason, codeClassification: codePreflight.codeClassification, profileId: codePreflight.profileId, deterministicFailure: true },
        recovery: { kind: "not_dispatched", reason: "code_execution_profile_unavailable" },
        observation: { state: "unavailable" as const, reason: codePreflight.reason },
        artifacts: [],
      };
    }
    const stagedAttachments = input.item.inputAttachments.length
      ? await loadGenerationInputAttachments({
        generationRunId: input.item.runId,
        attachmentIds: declaredAttachmentIds,
      })
      : [];
    if(input.item.inputAttachments.length && stagedAttachments.length === 0) {
      return {
        status: "failed",
        text: "沙盒未找到工具请求中声明的会话附件，未执行分析。",
        recovery: { kind: "not_dispatched", reason: "declared_attachments_unavailable" },
        details: { requestedAttachmentIds: effectiveRequest.attachmentIds },
        artifacts: [],
      };
    }
    const transferStartedAt = performance.now();
    // References and verified hashes are bound to the action/approval. The
    // Broker independently verifies them and transfers bytes only on dispatch.
    const transferredAttachments = stagedAttachments.map(attachment => ({
      attachmentId: attachment.id,
      fileName: buildSandboxAttachmentFileName(attachment.id, attachment.fileName),
      checksum: attachment.checksum, sizeBytes: attachment.sizeBytes,
    }));
    request.signal.throwIfAborted();
    const attachmentTransferMs = performance.now() - transferStartedAt;
    const normalizedProgramSource = normalizeInlineProgramSource(effectiveRequest.code);
    const execution = await executeAudienceTool(session.session.id, {
      ...common,
      capability: "exec",
      workingDirectory: "/workspace",
      isolatedPython: {
        profileId: "delegate.aio.single-python.v1",
        actionKey: sha256Text(effectiveRequest.context.idempotencyKey),
        source: normalizedProgramSource,
        timeoutMs: Math.min(codePreflight.maximumDurationMs ?? 30000, effectiveRequest.timeoutMs),
        inputs: transferredAttachments,
        ...(outputFile ? { outputFileName: outputFile.fileName } : {}),
      },
      ...(effectiveRequest.context.logicalAction ? { logicalAction: effectiveRequest.context.logicalAction } : {}),
    });
    request.signal.throwIfAborted();
    if(execution.outcome === "blocked") return {
      status: "denied", text: "服务端策略拒绝了本次执行。", observation: { state: "blocked" as const },
    };
    if(execution.outcome !== "completed") {
      if(execution.approvalRequest) input.onPendingApproval(execution.approvalRequest.id);
      const unknown = execution.execution?.transportOutcome === "outcome_unknown";
      const outputRejection = execution.session?.failureReason;
      // Only this verified no-egress profile can safely correct a terminated
      // program failure. A missing/contradictory receipt or published file is
      // not proof of a harmless failure; retain the conservative path below.
      if(execution.outcome === "failed" && outputRejection === "isolated_python_program_failed"
        && execution.execution?.transportOutcome === "response_received"
        && execution.execution.semanticOutcome === "failed"
        && Number.isInteger(execution.execution.exitCode) && execution.execution.exitCode! > 0
        && typeof execution.execution.finishedAt === "string" && Number.isFinite(Date.parse(execution.execution.finishedAt))
        && !execution.artifacts.some(artifact => artifact.kind === "file")) {
        return {
          status: "failed", text: "隔离 Python 程序已明确以非零状态退出，没有交付文件。请检查并修正 Python 用法及工具定义中的输出契约；系统没有自动重试，也不会执行其他外部操作。调试说明写到 stderr，stdout 只输出最终文件内容。",
          details: { reason: outputRejection, transportOutcome: "response_received", exitCode: execution.execution.exitCode },
          recovery: { kind: "isolated_program_failed", reason: outputRejection }, artifacts: [],
        };
      }
      if(outputFile && execution.outcome === "failed"
        && execution.execution?.transportOutcome === "response_received"
        && ["output_not_supported_text", "output_csv_invalid", "output_json_invalid", "output_file_too_large"].includes(outputRejection ?? "")) {
        return {
          status: "failed",
          text: `隔离脚本已结束，但标准输出未通过文件校验（${outputRejection}），未生成可下载文件。expectedOutputs 只声明文件名，服务端将完整 stdout 保存为文件。请修正程序，让 stdout 只包含最终文件内容；调试说明写到 stderr。CSV 必须有表头且每行列数一致，不能混入平均值说明、Markdown 围栏或其他日志；JSON 必须是完整有效 JSON；输出不能超过 ${agentTextFileOutput.maximumBytes} 字节。仅在沙盒内写文件不等于交付。`,
          details: { reason: outputRejection, transportOutcome: "response_received" },
          recovery: { kind: "isolated_output_rejected", reason: outputRejection! },
          artifacts: [],
        };
      }
      return {
        status: execution.outcome,
        text: execution.outcome === "pending_approval"
          ? "沙盒执行正在等待审批，尚未生成结果。" : unknown ? "沙盒执行结果尚未确认，已停止后续操作，避免重复执行。" : "沙盒执行失败，未生成结果。",
        details: execution.approvalRequest ? { approvalId: execution.approvalRequest.id } : { transportOutcome: execution.execution?.transportOutcome },
        ...(unknown ? { observation: { state: "unknown" as const, reason: "isolated_python_outcome_unknown" } } : {}),
        artifacts: [],
      };
    }
    const stdoutArtifacts = execution.artifacts.filter(artifact => artifact.kind === "stdout");
    const contextSourceRef = await input.registerToolSource?.(execution.execution.id);
    const stdoutDetails = await Promise.all(stdoutArtifacts.map(async (artifact) =>
      readCurrentText(artifact, execution.execution.id, agentTextFileOutput.maximumBytes),
    ));
    if(outputFile && (stdoutDetails.length !== 1 || stdoutDetails.some(detail => !detail || detail.truncated !== false || typeof detail.contentText !== "string"))) {
      return { status: "failed", text: "沙盒已运行，但标准输出缺失、不完整或已被截断，未交付文件。", details: { reason: "output_stdout_unverified" }, artifacts: [] };
    }
    const verifiedStdout = stdoutDetails.map(detail => detail?.contentText ?? "").join("");
    if(outputFile) {
      const contentCheck = validateAgentTextOutputContent(outputFile, verifiedStdout);
      if(!contentCheck.ok) return { status: "failed", text: "沙盒已运行，但结果不满足所声明文件的格式或大小要求，未交付文件。", details: { reason: contentCheck.reason }, artifacts: [] };
    }
    // The approved Python action includes output permission and validated file
    // persistence, including approval continuation; no second business action.
    const delivered = execution;
    const fileArtifacts = outputFile ? delivered.artifacts.filter(artifact => artifact.kind === "file") : [];
    if(outputFile) {
      const artifact = fileArtifacts[0];
      if(fileArtifacts.length !== 1 || !artifact || artifact.sizeBytes > agentTextFileOutput.maximumBytes) {
        return { status: "failed", text: "执行端未返回唯一且符合限制的真实文件，未完成交付。", details: { reason: "output_artifact_missing_or_invalid" }, artifacts: [] };
      }
      const downloaded = await readCurrentArtifact(artifact, execution.execution.id, agentTextFileOutput.maximumBytes);
      if(!downloaded
        || downloaded.fileName !== outputFile.fileName
        || downloaded.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== outputFile.mimeType
        || downloaded.buffer.byteLength !== artifact.sizeBytes
        || !downloaded.buffer.equals(Buffer.from(verifiedStdout, "utf8"))) {
        return { status: "failed", text: "文件尚不能按当前接收者权限完整下载，或下载内容与声明不一致，未完成交付。", details: { reason: "output_download_unverified" }, artifacts: [] };
      }
    }
    const attachments = fileArtifacts
      .map((artifact) => ({
        fileName: outputFile!.fileName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        artifactId: artifact.id,
        url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
      }));
    for(const attachment of attachments) {
      if(!input.computeAttachments.some((candidate) => candidate.artifactId === attachment.artifactId)) {
        const staleIndex = input.computeAttachments.findIndex((candidate) =>
          candidate.fileName === attachment.fileName);
        if(staleIndex >= 0) input.computeAttachments.splice(staleIndex, 1);
        input.computeAttachments.push(attachment);
      }
    }
    return {
      status: "completed",
      text: attachments.length
        ? `沙盒真实执行完成并生成文件：${attachments.map((item) => item.fileName).join(", ")}`
        : "沙盒真实执行完成。",
      ...(contextSourceRef ? { contextSourceRef } : {}),
      details: {
        executionId: execution.execution.id,
        attachmentTransferMs,
        transferredAttachments: transferredAttachments.map((attachment) => ({
          fileName: attachment.fileName,
          sandboxPath: `/workspace/inputs/${attachment.fileName}`,
          checksum: attachment.checksum,
          provider: "tencent",
        })),
      },
      artifacts: attachments.map((attachment) => ({
        id: attachment.artifactId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
      })),
      ...(verifiedStdout ? { authoritativeSummary: verifiedStdout.slice(0, 40_000) } : {}),
    };
  };

  const browseSandbox: NonNullable<PiSandboxAdapter["browse"]> = async (request) => {
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if(!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return { status: "failed", text: "浏览器只接受不含凭据的 HTTP(S) 网页地址。", details: { verifiedFailure: true } };
    }
    await input.leaseGuard.confirmOwned();
    const session = await createAudienceComputeSession({
      representativeId: input.setup.id, contactId: input.item.contactId,
      conversationId: input.item.conversationId, generationRunId: input.item.runId,
      generationWorkLease: input.workLease, subagentId: "browser-agent",
      requestedCapabilities: ["browser"], reason: `${input.item.channel}:pi_sandbox_browser`,
    });
    const execution = await executeAudienceTool(session.session.id, {
      capability: "browser", subagentId: "browser-agent", url: url.href, domain: url.hostname,
      rejectApprovalWait: true,
      ...(request.context?.logicalAction ? { logicalAction: request.context.logicalAction } : {}),
      generationWorkLease: input.workLease, hasPaidEntitlement: false,
      browserMode: "deterministic", maxSteps: 1, allowMutations: false,
    });
    request.signal.throwIfAborted();
    input.leaseGuard.assertOwned();
    if(execution.outcome === "blocked") return {
      status: "denied", text: "服务端策略拒绝了本次执行。", observation: { state: "blocked" as const },
    };
    if(execution.outcome === "pending_approval") {
      if(!execution.approvalRequest) throw new Error("Browser approval response is missing.");
      input.onPendingApproval(execution.approvalRequest.id);
      return {
        status: "pending_approval", text: "沙盒浏览器正在等待审批，尚未打开网页。",
        details: { approvalId: execution.approvalRequest.id }
      };
    }
    if(execution.outcome !== "completed") {
      const failureCode = safeCapabilityFailureCode(execution.blockReasonCode ?? execution.session.failureReason);
      const text = "沙盒浏览器访问失败，未取得可验证的网页内容。";
      return {
        status: "failed", text, authoritativeSummary: text,
        details: { executionId: execution.execution.id, verifiedFailure: true, failureCode }
      };
    }
    const pageArtifact = execution.artifacts.find(artifact => artifact.kind === "json");
    const contextSourceRef = await input.registerToolSource?.(execution.execution.id);
    const detail = pageArtifact
      ? await readCurrentText(pageArtifact, execution.execution.id, 128_000)
      : null;
    let page: { title?: string; contentSnippet?: string; finalUrl?: string; textSnippet?: string; links?: unknown; httpStatus?: number; observedAt?: string } | null = null;
    try { page = detail?.contentText ? JSON.parse(detail.contentText) : null; } catch { /* fail closed below */ }
    if(!page || typeof page.finalUrl !== "string" || typeof page.textSnippet !== "string") {
      return { status: "failed", text: "浏览器已运行，但网页结果缺失或无法解析。", details: { verifiedFailure: true } };
    }
    const screenshots = execution.artifacts.filter(artifact => artifact.kind === "screenshot");
    const visibleScreenshots = await Promise.all(screenshots.map(async artifact =>
      await readCurrentArtifact(artifact, execution.execution.id, 20 * 1024 * 1024) ? artifact : null));
    const artifacts = visibleScreenshots.filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null).map(artifact => ({
      id: artifact.id, fileName: resolvePublicArtifactFileName(artifact), mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes, url: `/reps/${input.item.representativeSlug}/chat/artifacts/${artifact.id}/download`,
    }));
    for(const artifact of artifacts) input.computeAttachments.push({
      artifactId: artifact.id, fileName: artifact.fileName, mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes, url: artifact.url,
    });
    const observedAt = execution.execution.finishedAt ?? new Date().toISOString();
    const { contentSnippet: _html, ...visiblePage } = page;
    return {
      status: "completed", text: JSON.stringify({ ...visiblePage, observedAt }), artifacts,
      resultRef: execution.execution.id,
      ...(contextSourceRef ? { contextSourceRef } : {}),
      observation: observeBrowserPage({ ...page, observedAt }),
      sources: [{
        id: pageArtifact!.id, title: page.title || page.finalUrl, channel: "web",
        provider: "Tencent sandbox browser", url: page.finalUrl, observedAt
      }],
    };
  };

  return {
    ...(isKnowledgeRetrievalServiceConfigured() ? {
      knowledge: {
        retrieve: async ({ query }: { query: string }) => {
          const retrievalQuery = query;
          const recalled = await recallRepresentativeContext({
            representativeSlug: input.item.representativeSlug,
            conversationId: input.item.conversationId,
            contactId: input.item.contactId,
            sourceChannel: input.item.channel,
            generationRunId: input.item.runId,
            queryText: retrievalQuery,
            allowedSourceKinds: ["PUBLIC_KNOWLEDGE"],
          }).catch(() => ({ items: [], citations: [], memoryUseRunId: undefined }));
          if(recalled.items.length && (!recalled.memoryUseRunId || !input.registerKnowledgeSources)) throw new AgentContextAuthorizationError();
          if(recalled.memoryUseRunId && input.registerKnowledgeSources) await input.registerKnowledgeSources(recalled.memoryUseRunId, recalled.items.map(item => item.memoryUseItemId));
          input.onMemoryUse(
            recalled.memoryUseRunId,
            recalled.memoryUseRunId ? recalled.items.map((entry) => entry.memoryUseItemId) : [],
          );
          const sources = recalled.items.map((entry, index) => ({
            id: entry.memoryUseItemId,
            title: entry.internalSource.publicTitle
              ?? recalled.citations[index]?.title
              ?? `知识资料 ${index + 1}`,
            channel: "knowledge" as const,
          }));
          // Only live authorized ledger entries may supply evidence.
          return {
            status: recalled.items.length ? "found" : recalled.memoryUseRunId ? "not_found" : "unavailable",
            text: recalled.items.length
              ? recalled.items.map((entry, index) => `[S:${sources[index]!.id}] ${sources[index]!.title}\n${entry.content || entry.abstract}`).join("\n\n")
              : recalled.memoryUseRunId ? "授权知识库没有找到支持该问题的资料。" : "授权知识检索当前不可用。",
            sources,
            details: { allowedCitationTitles: sources.map(source => source.title) },
          };
        },
      }
    } : {}),
    ...(input.authority?.mcpBindings.length
      ? {
        mcp: {
          listTools: async () => input.authority!.mcpBindings.flatMap((binding) =>
            (binding.toolDefinitions ?? [])
              .filter((tool) => !binding.allowedToolNames.length || binding.allowedToolNames.includes(tool.exactToolName))
              .map((tool) => {
                const policy = resolveMcpToolPolicy(binding, tool.exactToolName);
                const readOnly = policy?.effect.mutation === "none";
                return {
                  server: binding.slug,
                  name: tool.exactToolName,
                  description: tool.description || `Call ${tool.exactToolName} on ${binding.slug}.`,
                  inputSchema: projectMcpModelInputSchema(tool.inputSchema, policy),
                  effectClassification: policy ? (readOnly ? "read" as const : "write" as const) : "unknown" as const,
                  readOnly,
                  idempotent: readOnly || policy?.idempotency === "naturally_idempotent",
                  approvalRequired: binding.approvalRequired,
                };
              })),
          callTool: async ({ server, tool, arguments: toolArguments, context }) => {
            const binding = input.authority!.mcpBindings.find((candidate) => candidate.slug === server);
            if(!binding) throw new Error(`MCP binding ${server} is unavailable.`);
            const policy = resolveMcpToolPolicy(binding, tool);
            if(!policy) {
              return {
                status: "failed",
                text: "该工具的实际行为尚未完成服务端分类，本次未执行。审批不能替代行为分类。",
                details: { failureCode: "mcp_tool_behavior_unclassified" },
              };
            }
            const result = await executeMcp({
              bindingId: binding.id,
              bindingSlug: binding.slug,
              toolName: tool,
              toolArguments,
              estimatedTokens: binding.estimatedTokensPerCall,
              readOnly: policy.effect.mutation === "none",
              searchResults: policy.effect.mutation === "none" && policy.semantics?.evidenceClasses.includes("search_snippet") === true,
              ...(context?.logicalAction ? { logicalAction: context.logicalAction } : {}),
            });
            return attachVerifiedMcpSource(result, {
              server,
              tool,
              runId: input.item.runId,
            });
          },
        }
      }
      : {}),
    ...(input.setup.skillPacks.some((skill) => skill.enabled)
      ? {
        skills: {
          discover: async ({ query, maximumResults }) => {
            const queryTerms = searchableTerms(query);
            const configured = input.setup.skillPacks
              .filter((skill) => skill.enabled)
              .map((skill) => ({
                descriptor: {
                  id: skill.slug,
                  version: skill.version ?? "1",
                  name: skill.displayName,
                  description: skill.summary,
                },
                score: [...searchableTerms([skill.displayName, skill.summary, ...skill.capabilityTags].join(" "))]
                  .filter((term) => queryTerms.has(term)).length,
              }));
            const ranked = configured.sort((left, right) => right.score - left.score);
            const matching = ranked.filter((entry) => entry.score > 0);
            return (matching.length ? matching : ranked).slice(0, maximumResults).map((entry) => entry.descriptor);
          },
          load: async ({ id, version }) => {
            const skill = input.setup.skillPacks.find((candidate) =>
              candidate.enabled && candidate.slug === id && (!version || (candidate.version ?? "1") === version));
            if(!skill) throw new Error(`Skill ${id} is not installed at the requested version.`);
            return {
              descriptor: {
                id: skill.slug,
                version: skill.version ?? "1",
                name: skill.displayName,
                description: skill.summary,
              },
              instructions: [
                `Skill: ${skill.displayName}@${skill.version ?? "1"}`,
                skill.instructions ?? skill.summary,
                skill.capabilityTags.length ? `Required capability tags: ${skill.capabilityTags.join(", ")}` : "",
                skill.executesCode
                  ? "Use the isolated sandbox capability for all code execution. Loading this Skill does not mean the requested work is complete."
                  : "Apply this method to the current request and verify the resulting output.",
              ].filter(Boolean).join("\n"),
              ...(skill.instructionsSha256
                ? { instructionsDigest: skill.instructionsSha256 }
                : {}),
              ...((skill.resources?.length || skill.sourceUrl)
                ? { resources: [...(skill.resources ?? []), ...(skill.sourceUrl ? [skill.sourceUrl] : [])] }
                : {}),
            };
          },
        }
      }
      : {}),
    ...(input.setup.compute.enabled ? {
      sandbox: {
        executionDescription: `Only Python is available after host preflight. ${agentTextFileOutputNotice.en} expectedOutputs declares the delivered filename; the host saves COMPLETE stdout as that file. Output only the final file bytes to stdout; send logs/explanations to stderr. CSV must have a non-empty unique header and equal column counts on every row. Use writer = csv.writer(sys.stdout), then writer.writerow([...]) or writer.writerows([...]); csv.writer is NOT a context manager, so never use with csv.writer(...). Alternatively use sys.stdout.write(csv_text); do not add blank rows, a separate average/log line, or Markdown fences. Writing a file inside the sandbox alone does not deliver it; return its exact contents on stdout.`,
        execute: executeSandbox,
        ...(["allow", "ask"].includes(input.authority?.compute?.capabilityModes?.browser ?? "deny") ? { browse: browseSandbox } : {}),
      }
    } : {}),
  };
}

export function normalizeExpectedSandboxOutputs(outputs: readonly string[]) {
  return outputs.map((output) => output.trim()).filter((output) =>
    Boolean(output)
    && !/^(?:-|stdout|\/dev\/stdout)$/iu.test(output));
}

export function normalizeInlineProgramSource(code: string) {
  if(code.includes("\n")) return code;
  if(!/\\n\s*(?:import\b|from\b|with\b|def\b|class\b|if\b|for\b|while\b|try\b|except\b|print\b|[A-Za-z_][A-Za-z0-9_]*\s*=)/u.test(code)) {
    return code;
  }
  return code.replace(/\\r\\n|\\n/gu, "\n");
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function attachVerifiedMcpSource(
  result: PiCapabilityResult,
  input: { server: string; tool: string; runId: string },
): PiCapabilityResult {
  const successful = typeof result.status === "string"
    && ["completed", "succeeded", "success", "found", "ok"].includes(
      result.status.toLowerCase(),
    );
  if(!successful || result.observation?.state === "blocked") return { ...result, sources: [] };
  return {
    ...result,
    sources: [
      ...(result.sources ?? []),
      {
        id: `${input.server}:${input.tool}:${input.runId}`,
        title: `${input.server}/${input.tool}`,
        channel: "mcp",
        provider: input.server,
        ...(result.observation?.observedAt ? { observedAt: result.observation.observedAt } : {}),
      },
    ],
  };
}

function safeCapabilityFailureCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_:-]{1,160}$/u.test(value)
    ? value
    : undefined;
}

function resolvePublicArtifactFileName(artifact: { id: string; kind: string; mimeType: string }) {
  const extension = artifact.mimeType.includes("json") ? "json"
    : artifact.mimeType.includes("csv") ? "csv"
      : artifact.mimeType.includes("png") ? "png"
        : artifact.mimeType.includes("jpeg") ? "jpg" : "txt";
  return `${artifact.kind}-${artifact.id}.${extension}`;
}

/** A transport observation, not a judgement of relevance or source freshness. */
export function observeBrowserPage(page: { textSnippet?: string; httpStatus?: number; observedAt?: string }): NonNullable<PiCapabilityResult["observation"]> {
  const state = page.httpStatus && page.httpStatus >= 400 ? "blocked"
    : !page.textSnippet?.trim() ? "empty" : "available";
  return {
    state, ...(page.httpStatus !== undefined ? { httpStatus: page.httpStatus } : {}),
    ...(page.observedAt ? { observedAt: page.observedAt } : {})
  };
}

function searchableTerms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_-]{2,}|\p{Script=Han}{2,}/gu) ?? []);
  for(const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for(let index = 0;index < run.length - 1;index += 1) terms.add(run.slice(index, index + 2));
  }
  return terms;
}
