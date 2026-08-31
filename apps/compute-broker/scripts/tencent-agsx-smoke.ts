import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import { TencentAgsxSandboxProvider } from "../src/tencent-agsx-provider";
import type { SandboxProviderLease } from "../src/sandbox-provider";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

async function main() {
  const apiKey = required("TENCENT_AGS_API_KEY");
  const domain = resolveDomain();
  const codeTool = required("TENCENT_AGS_CODE_TOOL");
  const runId = `smoke-${Date.now()}`;
  const provider = new TencentAgsxSandboxProvider({ apiKey, domain, codeTool });
  let lease: SandboxProviderLease | null = null;

  try {
    const startedAt = Date.now();
    lease = await provider.start({
      sandboxIdentityId: runId,
      sandboxLeaseId: runId,
      creationKey: createHash("sha256").update(runId).digest("hex"),
      runtimeClass: "code",
      runnerType: "docker",
      image: "delegate-code-v1",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: runId,
    });
    const startMs = Date.now() - startedAt;
    const execution = await provider.execute({
      lease,
      runnerType: "docker",
      command: "printf delegate-tencent-smoke",
      maxCommandSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-exec`,
    });
    if (execution.exitCode !== 0 || execution.stdout !== "delegate-tencent-smoke") {
      throw new Error("tencent_agsx_execution_contract_failed");
    }

    const egress = await provider.execute({
      lease,
      runnerType: "docker",
      command: "node -e \"fetch('https://example.com').then(()=>process.exit(7)).catch(()=>process.exit(0))\"",
      maxCommandSeconds: 15,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-egress`,
    });
    if (egress.exitCode !== 0) throw new Error("tencent_agsx_no_network_contract_failed");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "tencent",
      domain,
      codeTool,
      startMs,
      executionMs: execution.wallMs,
      noNetworkVerified: true,
    })}\n`);
  } finally {
    if (lease) {
      await provider.delete({ lease, sessionId: runId }).catch(() => undefined);
    }
  }
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
