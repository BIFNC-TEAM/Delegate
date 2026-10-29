import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { TencentAgsxSandboxProvider } from "../src/tencent-agsx-provider";
import type { SandboxProviderLease } from "../src/sandbox-provider";

const root = resolve(import.meta.dirname, "../../..");
loadEnv({ path: resolve(root, ".env"), quiet: true });
async function main() {
  if (process.env.DELEGATE_RUN_CLOUD_BOUNDARY_PROBE !== "1") throw new Error("explicit_probe_opt_in_required");
  const apiKey = process.env.TENCENT_AGS_API_KEY?.trim(); const tool = process.env.TENCENT_AGS_ALL_IN_ONE_TOOL?.trim();
  const domain = process.env.TENCENT_AGS_DOMAIN?.trim().replace(/^https?:\/\//u, "").replace(/\/$/u, "") || `${process.env.TENCENT_AGS_REGION?.trim()}.tencentags.com`;
  if (!apiKey || !tool) throw new Error("configuration_missing");
  const id = `d04b-primitives-${randomUUID()}`;
  const provider = new TencentAgsxSandboxProvider({ apiKey, domain, allInOneTool: tool, sandboxTimeoutMs: 180_000 });
  let lease: SandboxProviderLease | undefined;
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), syntheticOnly: true, applicationDatabaseAccessed: false };
  const privatePath = resolve(root, ".local/agent-remediation/d04b-primitives-lease.json");
  await mkdir(resolve(root, ".local/agent-remediation"), { recursive: true });
  await writeFile(privatePath, JSON.stringify({ id, creationKey: id, cleanup: "creating" }), { mode: 0o600 });
  try {
    lease = await provider.start({ sandboxIdentityId: id, sandboxLeaseId: id, creationKey: id, runtimeClass: "code", runnerType: "docker", image: tool, hostWorkspaceRoot: "/workspace", networkMode: "full", filesystemMode: "ephemeral_full", sessionId: id });
    await writeFile(privatePath, JSON.stringify({ id, lease, cleanup: "pending" }), { mode: 0o600 });
    const source = `import os,json,pathlib,shutil,subprocess,uuid,ctypes.util
result={"architecture":os.uname().machine,"seccompLibrary":ctypes.util.find_library('seccomp'),"tools":{n:shutil.which(n) for n in ["python3","node","sh","mount","unshare","setpriv","timeout","prlimit"]}}
root=pathlib.Path('/sys/fs/cgroup')
result['cgroup']={}
for name in ['cgroup.controllers','cgroup.subtree_control','memory.max','cpu.max','pids.max']:
 try: result['cgroup'][name]=(root/name).read_text().strip()[:200]
 except OSError as e: result['cgroup'][name]={'errno':e.errno}
group=root/('delegate-probe-'+uuid.uuid4().hex)
try:
 group.mkdir()
 result['cgroup']['created']=True
 for name,value in [('memory.max','67108864'),('pids.max','16'),('cpu.max','10000 100000')]:
  try:
   if not (group/name).exists():
    result['cgroup'][name+'_child']={'missing':True}
    continue
   (group/name).write_text(value)
   result['cgroup'][name+'_child']=(group/name).read_text().strip()
  except OSError as e: result['cgroup'][name+'_child']={'errno':e.errno}
except OSError as e: result['cgroup']['createError']={'errno':e.errno}
finally:
 if group.exists():
  try: group.rmdir()
  except OSError as e: result['cgroup']['cleanupError']={'errno':e.errno}
print(json.dumps(result))`;
    const encoded = Buffer.from(source).toString("base64");
    const execution = await provider.execute({ lease, runnerType: "docker", command: `python -c "import base64;exec(base64.b64decode('${encoded}'))"`, maxCommandSeconds: 15, maxStdoutBytes: 4096, maxStderrBytes: 4096, filesystemMode: "ephemeral_full", sessionId: id, executionId: id });
    report.execution = { exitCode: execution.exitCode, termination: execution.termination };
    if (execution.exitCode === 0) report.result = JSON.parse(execution.stdout);
    else { report.failure = "primitive_probe_failed"; process.exitCode = 1; }
  } catch (error) {
    report.failure = error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 100) : "probe_failed"; process.exitCode = 1;
  } finally {
    let deleted = false;
    for (let n=0;lease && !deleted && n<3;n++) { try { await provider.delete({ lease, sessionId:id }); deleted=true; } catch {} }
    report.deleted=deleted;
    if (!deleted) process.exitCode=1;
    await writeFile(privatePath,JSON.stringify({id,lease,cleanup:deleted?'deleted':'needs_reconciliation'}),{mode:0o600});
    report.finishedAt=new Date().toISOString();
    const out=resolve(root,'reports/agent-remediation/20260929-d04b');await mkdir(out,{recursive:true});
    const label=process.argv[2]??'aio-primitives';if(!/^[a-z0-9-]+$/.test(label))throw new Error('invalid_label');
    await writeFile(resolve(out,label+'.json'),JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report)+'\n');
  }
}
main().catch(()=>{process.stderr.write('primitive_probe_setup_failed\n');process.exitCode=1;});
