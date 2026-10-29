/** Opt-in, bounded probes in ONE fresh AIO instance. No app DB, real documents,
 * business requests or credential/environment dumps. This does not register
 * an execution profile or bypass the production Broker admission gate. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { TencentAgsxSandboxProvider } from "../src/tencent-agsx-provider";
import type { SandboxProviderLease } from "../src/sandbox-provider";

const root = resolve(import.meta.dirname, "../../..");
loadEnv({ path: resolve(root, ".env"), quiet: true });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function main() {
  if (process.env.DELEGATE_RUN_CLOUD_BOUNDARY_PROBE !== "1") throw new Error("explicit_cloud_probe_opt_in_required");
  const apiKey = process.env.TENCENT_AGS_API_KEY?.trim();
  const allInOneTool = process.env.TENCENT_AGS_ALL_IN_ONE_TOOL?.trim();
  const domain = process.env.TENCENT_AGS_DOMAIN?.trim().replace(/^https?:\/\//u, "").replace(/\/$/u, "")
    || (process.env.TENCENT_AGS_REGION?.trim() ? `${process.env.TENCENT_AGS_REGION.trim()}.tencentags.com` : undefined);
  if (!apiKey || !allInOneTool || !domain) throw new Error("aio_probe_configuration_missing");
  const runId = `d04-probe-${randomUUID()}`;
  const provider = new TencentAgsxSandboxProvider({ apiKey, domain, allInOneTool, sandboxTimeoutMs: 120_000 });
  let lease: SandboxProviderLease | null = null;
  let creationAttempted = false;
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), templateFingerprint: digest(allInOneTool), syntheticOnly: true, applicationDatabaseAccessed: false, profileRegistered: false };
  const label = process.argv[2] ?? "d04-aio-boundary-probe";
  if (!/^[a-z0-9-]{1,80}$/u.test(label)) throw new Error("invalid_probe_label");
  const output = resolve(root, `reports/agent-remediation/20260928-100420/${label}.json`);
  const privateLease = resolve(root, ".local/agent-remediation/d04-cloud-probe-lease.json");
  const execute = async (source: string, id: string, seconds = 15) => {
    const encoded = Buffer.from(source).toString("base64");
    return provider.execute({ lease: lease!, runnerType: "docker", command: `python -c "import base64;exec(compile(base64.b64decode('${encoded}'),'<boundary-probe>','exec'))"`,
      maxCommandSeconds: seconds, filesystemMode: "ephemeral_full", workingDirectory: "/workspace", sessionId: runId, executionId: `${runId}-${id}`, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
  };
  try {
    // A host-only canary, never passed in provider metadata or guest commands.
    process.env.DELEGATE_PROBE_HOST_CANARY = randomUUID();
    await mkdir(resolve(root, ".local/agent-remediation"), { recursive: true });
    await writeFile(privateLease, JSON.stringify({ runId, creationKey: digest(runId), cleanup: "creating" }), { mode: 0o600 });
    creationAttempted = true;
    lease = await provider.start({ sandboxIdentityId: runId, sandboxLeaseId: runId, creationKey: digest(runId), runtimeClass: "code", runnerType: "docker",
      image: allInOneTool, hostWorkspaceRoot: "/workspace", networkMode: "full", filesystemMode: "ephemeral_full", sessionId: runId });
    await mkdir(resolve(root, ".local/agent-remediation"), { recursive: true });
    await writeFile(privateLease, JSON.stringify({ runId, lease, cleanup: "pending" }), { mode: 0o600 });
    report.sandboxRef = digest(lease.providerSandboxId ?? "");
    const capabilities = await execute(`import json,os,shutil,subprocess
def probe(args):
    if not shutil.which(args[0]): return {"available":False,"reason":"missing_binary"}
    try:
        p=subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
        return {"available":p.returncode==0,"exitCode":p.returncode}
    except subprocess.TimeoutExpired: return {"available":False,"reason":"timeout"}
print(json.dumps({"nonRootUid":os.geteuid()!=0,"hostOnlyCanaryInherited":os.getenv("DELEGATE_PROBE_HOST_CANARY") is not None,"cgroupRootWritable":os.access("/sys/fs/cgroup",os.W_OK),"userNetworkNamespace":probe(["unshare","--user","--map-root-user","--net","true"]),"userMountPidNamespace":probe(["unshare","--user","--map-root-user","--mount","--pid","--fork","--mount-proc","true"]),"bubblewrapPresent":shutil.which("bwrap") is not None}))`, "primitives");
    if (capabilities.exitCode !== 0) throw new Error("aio_primitive_probe_failed");
    report.primitives = JSON.parse(capabilities.stdout);
    const marker = `/home/user/workspace/${runId}.txt`;
    const childDelayMs = 6000;
    const child = `import time,pathlib; time.sleep(6); pathlib.Path(${JSON.stringify(marker)}).write_text('synthetic')`;
    const timeout = await execute(`import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}])\ntime.sleep(12)`, "timeout", 1);
    report.deadlineObservation = { termination: timeout.termination, exitCode: timeout.exitCode, hostWallMs: timeout.wallMs, childDelayMs };
    const observed = await execute(`import time,pathlib,json\ntime.sleep(7)\nprint(json.dumps({"childMarkerPresent":pathlib.Path(${JSON.stringify(marker)}).exists()}))`, "observe", 15);
    if (observed.exitCode !== 0) throw new Error("aio_deadline_observation_failed");
    const afterDeadline = JSON.parse(observed.stdout);
    report.afterDeadline = afterDeadline;
    report.childWroteAfterReportedTimeout = timeout.termination === "command_timeout" && timeout.wallMs < childDelayMs && afterDeadline.childMarkerPresent === true;
    report.probeCompleted = true;
  } catch (error) {
    report.probeCompleted = false;
    report.errorCode = error && typeof error === "object" && "code" in error ? String(error.code).replace(/[^A-Z0-9_]/giu, "").slice(0, 100) : "probe_failed";
    process.exitCode = 1;
  } finally {
    // A missing handle after a create attempt does not prove no remote instance
    // exists. Retain the creation key for reconciliation and never auto-recreate.
    let deleted = !creationAttempted;
    if (!lease && creationAttempted) report.creationOutcomeUnknown = true;
    for (let attempt = 0; lease && !deleted && attempt < 3; attempt += 1) {
      try { await provider.delete({ lease, sessionId: runId }); deleted = true; } catch { /* Only safe status is retained. */ }
    }
    report.deleted = deleted;
    if (lease) await writeFile(privateLease, JSON.stringify({ runId, lease, cleanup: deleted ? "deleted" : "needs_cleanup" }), { mode: 0o600 });
    if (!deleted) process.exitCode = 1;
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}
main().catch(() => { process.stderr.write("aio_boundary_probe_setup_failed\n"); process.exitCode = 1; });
