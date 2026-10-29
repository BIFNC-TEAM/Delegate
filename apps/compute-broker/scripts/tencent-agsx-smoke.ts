import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import { TencentAgsxSandboxProvider } from "../src/tencent-agsx-provider";
import type { SandboxProviderLease } from "../src/sandbox-provider";
import { buildPlaywrightBrowseCommand, buildPlaywrightNativeCommand, parsePlaywrightBrowseArtifactPayload } from "../src/browser";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

async function main() {
  const apiKey = required("TENCENT_AGS_API_KEY");
  const domain = resolveDomain();
  const allInOneTool = process.env.TENCENT_AGS_ALL_IN_ONE_TOOL?.trim() || undefined;
  const codeTool = allInOneTool ? undefined : required("TENCENT_AGS_CODE_TOOL");
  const template = allInOneTool ?? codeTool!;
  const networkMode = allInOneTool ? "full" as const : "no_network" as const;
  const runId = `smoke-${Date.now()}`;
  const provider = new TencentAgsxSandboxProvider({ apiKey, domain, codeTool, allInOneTool });
  let lease: SandboxProviderLease | null = null;
  let report: Record<string, unknown> | undefined;
  const startInput = {
    sandboxIdentityId: runId,
    sandboxLeaseId: runId,
    creationKey: createHash("sha256").update(runId).digest("hex"),
    runtimeClass: allInOneTool ? "browser" as const : "code" as const,
    runnerType: "docker" as const,
    image: template,
    hostWorkspaceRoot: "/workspace",
    networkMode,
    filesystemMode: "ephemeral_full" as const,
    sessionId: runId,
  };

  try {
    const startedAt = Date.now();
    lease = await provider.start(startInput);
    const startMs = Date.now() - startedAt;
    const inputBytes = Buffer.from("order_id,quantity,unit_price,refund_amount\nO1,2,10,1\n", "utf8");
    const inputChecksum = createHash("sha256").update(inputBytes).digest("hex");
    const inputTransfer = await provider.writeInput({
      lease,
      sessionId: runId,
      path: "/workspace/inputs/orders.csv",
      content: inputBytes,
      timeoutMs: 30_000,
    });
    const execution = await provider.execute({
      lease,
      runnerType: "docker",
      command: "python -c \"import hashlib,pathlib; b=pathlib.Path('inputs/orders.csv').read_bytes(); print(f'{len(b)}:{hashlib.sha256(b).hexdigest()}', end='')\"",
      maxCommandSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-exec`,
    });
    if (execution.exitCode !== 0 || execution.stdout !== `${inputBytes.byteLength}:${inputChecksum}`) {
      throw new Error("tencent_agsx_execution_contract_failed");
    }

    const egress = await provider.execute({
      lease,
      runnerType: "docker",
      command: allInOneTool
        ? "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:7)).catch(()=>process.exit(8))\""
        : "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(7)).catch(()=>process.exit(0))\"",
      maxCommandSeconds: 15,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-egress`,
    });
    if (egress.exitCode !== 0) throw new Error(`tencent_agsx_${networkMode}_contract_failed`);

    let browserVerified = false;
    if (allInOneTool) {
      const url = `data:text/html,${encodeURIComponent('<title>Delegate AIO</title><button style="width:160px;height:80px" onclick="this.textContent=\'clicked\'">ready</button>')}`;
      const executeBrowser = (command: string) => provider.execute({
        lease: lease!, runnerType: "docker", command, maxCommandSeconds: 30,
        maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024,
        filesystemMode: "ephemeral_full", workingDirectory: "/workspace",
        sessionId: runId, executionId: `${runId}-browser`,
      });
      const browse = await executeBrowser(buildPlaywrightBrowseCommand({ url, playwrightVersion: "1.58.2" }));
      const payload = parsePlaywrightBrowseArtifactPayload(browse.stdout);
      if (browse.exitCode !== 0 || payload?.title !== "Delegate AIO" || !payload.screenshotBase64
        || payload.profilePath !== "/home/user/workspace/browser-profile") {
        throw new Error("tencent_agsx_browser_contract_failed");
      }
      const actions = await executeBrowser(buildPlaywrightNativeCommand({
        transportKind: "openai_computer", playwrightVersion: "1.58.2", currentUrl: url,
        actions: [{ type: "click", x: 80, y: 40 }],
      }));
      const actionPayload = parsePlaywrightBrowseArtifactPayload(actions.stdout);
      if (actions.exitCode !== 0 || !actionPayload?.textSnippet.includes("clicked")) {
        throw new Error("tencent_agsx_browser_action_contract_failed");
      }
      browserVerified = true;
    }

    await provider.stop({ lease, sessionId: runId });
    lease = await provider.start({ ...startInput, providerSandboxId: lease.providerSandboxId });
    const resumed = await provider.execute({
      lease, runnerType: "docker", command: "cat /workspace/inputs/orders.csv",
      maxCommandSeconds: 15, filesystemMode: "ephemeral_full", workingDirectory: "/workspace",
      sessionId: runId, executionId: `${runId}-resume`,
    });
    if (resumed.exitCode !== 0 || resumed.stdout !== inputBytes.toString("utf8")) {
      throw new Error("tencent_agsx_resume_contract_failed");
    }

    report = {
      ok: true,
      provider: "tencent",
      domain,
      template,
      networkMode,
      startMs,
      inputTransferMs: inputTransfer.durationMs,
      inputBytes: inputTransfer.bytes,
      inputChecksumVerified: true,
      executionMs: execution.wallMs,
      networkPolicyVerified: true,
      browserVerified,
      pauseResumeVerified: true,
    };
  } finally {
    if (lease) {
      await provider.delete({ lease, sessionId: runId });
    }
  }
  process.stdout.write(`${JSON.stringify({ ...report, cleanupCompleted: true })}\n`);
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function resolveDomain() {
  const domain = process.env.TENCENT_AGS_DOMAIN?.trim();
  if (domain) return domain.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  return `${required("TENCENT_AGS_REGION")}.tencentags.com`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "tencent_agsx_smoke_failed"}\n`);
  process.exitCode = 1;
});
