import { execFile } from "node:child_process";
import { promisify } from "node:util";
/** Read only selected container identities, never environment variables or compose secrets. */
export async function readTestDeployment() {
  const run = promisify(execFile);
  const names = ["delegate-agent-test-reps-1", "delegate-agent-test-conversation-worker-1", "delegate-agent-test-compute-broker-1"];
  try {
    return await Promise.all(names.map(async name => {
      const { stdout } = await run("docker", ["inspect", "--format", "{{.Id}} {{.Config.Image}}", name], { timeout: 5000 });
      const [id, image] = stdout.trim().split(/\s+/);
      return { name, id, image };
    }));
  } catch { return null; }
}
