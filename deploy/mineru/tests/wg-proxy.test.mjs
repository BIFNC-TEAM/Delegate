import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const proxyPath = fileURLToPath(new URL("../wg-proxy.py", import.meta.url));
const runScriptPath = fileURLToPath(new URL("../run-wg-proxy.sh", import.meta.url));

test("proxies MinerU health traffic and passes its own healthcheck", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "healthy", marker: "wg-proxy-test" }));
  });
  await listen(upstream);
  context.after(() => upstream.close());

  const listenPort = await reservePort();
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");
  const env = {
    ...process.env,
    MINERU_WG_LISTEN_HOST: "127.0.0.1",
    MINERU_WG_LISTEN_PORT: String(listenPort),
    MINERU_UPSTREAM_HOST: "127.0.0.1",
    MINERU_UPSTREAM_PORT: String(upstreamAddress.port),
  };
  const proxy = spawn("python3", [proxyPath], { env, stdio: "ignore" });
  context.after(() => proxy.kill("SIGTERM"));

  const response = await waitForResponse(`http://127.0.0.1:${listenPort}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "healthy",
    marker: "wg-proxy-test",
  });

  const healthcheck = await run("python3", [proxyPath, "--check"], { env });
  assert.equal(healthcheck.code, 0, healthcheck.stderr);
});

test("rejects public and wildcard listener addresses", () => {
  for (const host of ["0.0.0.0", "8.8.8.8"]) {
    const result = spawnSync("python3", [proxyPath, "--check"], {
      env: { ...process.env, MINERU_WG_LISTEN_HOST: host },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private or loopback IP address/u);
  }
});

test("runs the proxy container with a hardened runtime contract", () => {
  const script = spawnSync("bash", ["-n", runScriptPath], { encoding: "utf8" });
  assert.equal(script.status, 0, script.stderr);
  const source = String(
    spawnSync("sed", ["-n", "1,220p", runScriptPath], { encoding: "utf8" }).stdout,
  );
  for (const expected of [
    "--network host",
    "--read-only",
    "--user 65534:65534",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--health-cmd \"python3 /proxy.py --check\"",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(expected), "u"));
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function reservePort() {
  const server = createTcpServer();
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  return port;
}

async function waitForResponse(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}
