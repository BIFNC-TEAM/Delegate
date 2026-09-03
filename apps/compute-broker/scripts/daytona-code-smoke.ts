import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import {
  createSandboxProviderFromConfig,
  type SandboxProviderLease,
} from "../src/sandbox-provider";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env.local"), override: false, quiet: true });
loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), override: false, quiet: true });

async function main() {
  const apiKey = required("DAYTONA_API_KEY");
  const runId = `daytona-code-smoke-${Date.now()}`;
  const { provider } = await createSandboxProviderFromConfig({
    sandboxProvider: "daytona",
    daytona: {
      apiKey,
      ...(optional("DAYTONA_API_URL") ? { apiUrl: optional("DAYTONA_API_URL") } : {}),
      ...(optional("DAYTONA_TARGET") ? { target: optional("DAYTONA_TARGET") } : {}),
      resources: {
        cpu: positiveInteger("DAYTONA_SANDBOX_CPU", 1),
        memory: positiveInteger("DAYTONA_SANDBOX_MEMORY_GIB", 2),
        disk: positiveInteger("DAYTONA_SANDBOX_DISK_GIB", 4),
      },
      ttlMinutes: positiveInteger("DAYTONA_SANDBOX_TTL_MINUTES", 60),
    },
    sandboxLifecycle: {
      idleStopMinutes: 5,
      autoArchiveMinutes: 60,
      autoDeleteMinutes: 0,
    },
  });
  let lease: SandboxProviderLease | null = null;
  const startedAt = Date.now();
  try {
    lease = await provider.start({
      sandboxIdentityId: runId,
      sandboxLeaseId: runId,
      creationKey: runId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 64).padEnd(64, "0"),
      runtimeClass: "code",
      runnerType: "vm",
      image: optional("COMPUTE_RUNNER_IMAGE") ?? "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      networkAllowlist: [],
      filesystemMode: "ephemeral_full",
      sessionId: runId,
    });
    const execution = await provider.execute({
      lease,
      runnerType: "vm",
      command: "printf delegate-daytona-smoke",
      maxCommandSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-exec`,
    });
    if (execution.exitCode !== 0 || execution.stdout !== "delegate-daytona-smoke") {
      throw new Error(`daytona_execution_contract_failed:${JSON.stringify({
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        termination: execution.termination,
      })}`);
    }
    const egress = await provider.execute({
      lease,
      runnerType: "vm",
      command: [
        "python - <<'PY'",
        "import socket",
        "try:",
        "    connection = socket.create_connection(('1.1.1.1', 443), timeout=3)",
        "except OSError:",
        "    raise SystemExit(0)",
        "else:",
        "    connection.close()",
        "    raise SystemExit(7)",
        "PY",
      ].join("\n"),
      maxCommandSeconds: 15,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: runId,
      executionId: `${runId}-egress`,
    });
    if (egress.exitCode !== 0) throw new Error("daytona_no_network_contract_failed");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "daytona",
      startMs: Date.now() - startedAt,
      executionMs: execution.wallMs,
      noNetworkVerified: true,
    })}\n`);
  } finally {
    if (lease) await provider.delete({ lease, sessionId: runId }).catch(() => undefined);
  }
}

function optional(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function required(name: string) {
  const value = optional(name);
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function positiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(optional(name) ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "daytona_smoke_failed"}\n`);
  process.exitCode = 1;
});
