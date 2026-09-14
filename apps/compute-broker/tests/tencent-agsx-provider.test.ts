import { describe, expect, it, vi } from "vitest";

import {
  mapTencentAgsxError,
  readTencentCommandExitResult,
  TencentAgsxSandboxProvider,
  type TencentAgsxClientLike,
  type TencentAgsxSandboxLike,
} from "../src/tencent-agsx-provider";

describe("Tencent AGSX sandbox provider", () => {
  it("creates an isolated code sandbox with server-owned metadata", async () => {
    const sandbox = buildSandbox();
    const client = buildClient(sandbox);
    const provider = buildProvider(client);

    const lease = await provider.start(buildStartInput());

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      template: "delegate-code-v1",
      domain: "ap-guangzhou.tencentags.com",
      allowInternetAccess: false,
      metadata: {
        "delegate.sandbox_identity_id": "identity-1",
        "delegate.sandbox_lease_id": "lease-1",
        "delegate.creation_key": "creation-key-1",
        "delegate.runtime_class": "code",
      },
    }));
    expect(sandbox.commands.run).toHaveBeenCalledWith("mkdir -p /home/user/workspace", expect.objectContaining({
      cwd: "/home/user",
    }));
    expect(lease).toMatchObject({
      provider: "tencent",
      providerSandboxId: "tencent-sandbox-1",
      sessionRoot: "/home/user/workspace",
    });
  });

  it("enables Tencent internet access only for the explicit full-network policy", async () => {
    const sandbox = buildSandbox();
    const client = buildClient(sandbox);
    const provider = buildProvider(client);

    await provider.start({ ...buildStartInput(), networkMode: "full" });

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      allowInternetAccess: true,
    }));
  });

  it("connects to an existing sandbox and enforces cwd, timeout, and output limits", async () => {
    const sandbox = buildSandbox({ stdout: "abcdef", stderr: "uvwxyz" });
    const client = buildClient(sandbox);
    const provider = buildProvider(client);
    const lease = buildLease();

    const result = await provider.execute({
      runnerType: "docker",
      lease,
      command: "node task.js",
      maxCommandSeconds: 7,
      maxStdoutBytes: 3,
      maxStderrBytes: 4,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace/project",
      sessionId: "session-1",
      executionId: "execution-1",
    });

    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: "tencent-sandbox-1",
    }));
    expect(sandbox.commands.run).toHaveBeenCalledWith("node task.js", expect.objectContaining({
      cwd: "/home/user/workspace/project",
      timeoutMs: 7_000,
    }));
    expect(result).toMatchObject({
      exitCode: null,
      stdout: "abc",
      stderr: "uvwx",
      termination: "output_limit",
    });
  });

  it("maps the public /workspace contract inside command arguments", async () => {
    const sandbox = buildSandbox();
    const provider = buildProvider(buildClient(sandbox));
    await provider.execute({
      runnerType: "vm",
      lease: buildLease(),
      command: "python /workspace/inputs/task.py > /workspace/outputs/result.txt",
      maxCommandSeconds: 7,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: "session-1",
      executionId: "execution-path-map",
    });
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "python /home/user/workspace/inputs/task.py > /home/user/workspace/outputs/result.txt",
      expect.objectContaining({ cwd: "/home/user/workspace" }),
    );
  });

  it("pauses on stop and kills on delete", async () => {
    const sandbox = buildSandbox();
    const client = buildClient(sandbox);
    const provider = buildProvider(client);
    const lease = buildLease();

    await provider.stop({ lease, sessionId: "session-1" });
    await provider.delete({ lease, sessionId: "session-1" });

    expect(sandbox.pause).toHaveBeenCalledWith({ keepMemory: false });
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("uploads and re-reads an input file through the Tencent filesystem API", async () => {
    const sandbox = buildSandbox();
    const provider = buildProvider(buildClient(sandbox));
    const content = Buffer.from("order_id,amount\nO1,10\n");

    const result = await provider.writeInput({
      lease: buildLease(),
      sessionId: "session-1",
      path: "/workspace/inputs/orders.csv",
      content,
      timeoutMs: 12_000,
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/inputs/orders.csv",
      expect.any(ArrayBuffer),
      { requestTimeoutMs: 12_000 },
    );
    expect(sandbox.files.read).toHaveBeenCalledWith(
      "/home/user/workspace/inputs/orders.csv",
      { format: "bytes", requestTimeoutMs: 12_000 },
    );
    expect(result.bytes).toBe(content.byteLength);
  });

  it("fails closed when Tencent returns different bytes after upload", async () => {
    const sandbox = buildSandbox();
    sandbox.files.read = vi.fn(async () => Uint8Array.from([0]));
    const provider = buildProvider(buildClient(sandbox));

    await expect(provider.writeInput({
      lease: buildLease(),
      sessionId: "session-1",
      path: "/workspace/inputs/orders.csv",
      content: Buffer.from("expected"),
    })).rejects.toMatchObject({ code: "TRANSFER_INTEGRITY" });
  });

  it("stops accepting streamed output at the configured byte limit", async () => {
    const sandbox = buildSandbox();
    sandbox.commands.run = vi.fn(async (_command, options) => {
      await options.onStdout?.("abcdef");
      return { exitCode: 0, stdout: "abcdef", stderr: "" };
    });
    const provider = buildProvider(buildClient(sandbox));

    const result = await provider.execute({
      runnerType: "docker",
      lease: buildLease(),
      command: "printf abcdef",
      maxCommandSeconds: 7,
      maxStdoutBytes: 3,
      maxStderrBytes: 3,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: "session-1",
      executionId: "execution-1",
    });

    expect(result).toMatchObject({
      exitCode: null,
      stdout: "abc",
      termination: "output_limit",
    });
  });

  it("fails closed for browser, workspace mounts, or unenforceable network allowlists", async () => {
    const provider = buildProvider(buildClient(buildSandbox()));
    await expect(provider.start({ ...buildStartInput(), runtimeClass: "browser" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
    await expect(provider.start({ ...buildStartInput(), networkMode: "allowlist" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
    await expect(provider.start({ ...buildStartInput(), filesystemMode: "workspace_only" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
  });

  it("maps create timeouts to ambiguous outcomes without leaking provider text", () => {
    const mapped = mapTencentAgsxError(new Error("request timeout with secret=hidden"), true);
    expect(mapped).toMatchObject({ code: "AMBIGUOUS_CREATE", ambiguous: true });
    expect(mapped.message).toBe("ambiguous_create");
  });

  it("preserves a Tencent command non-zero exit as execution evidence", () => {
    expect(readTencentCommandExitResult({
      name: "CommandExitError",
      exitCode: 2,
      stdout: "partial output",
      stderr: "file not found",
    })).toEqual({
      exitCode: 2,
      stdout: "partial output",
      stderr: "file not found",
    });
    expect(readTencentCommandExitResult(new Error("transport failed"))).toBeNull();
  });

  it("rewrites workspace paths inside an encoded inline program", async () => {
    const sandbox = buildSandbox();
    const provider = buildProvider(buildClient(sandbox));
    const source = "print(open('/workspace/inputs/attachment.md').read())";
    const encoded = Buffer.from(source, "utf8").toString("base64");

    await provider.execute({
      runnerType: "vm",
      lease: buildLease(),
      command: `python -c "import base64;exec(compile(base64.b64decode('${encoded}'),'<pi-agent>','exec'))"`,
      maxCommandSeconds: 7,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace",
      sessionId: "session-1",
      executionId: "execution-inline-map",
    });

    const mappedSource = source.replace("/workspace", "/home/user/workspace");
    const mappedEncoded = Buffer.from(mappedSource, "utf8").toString("base64");
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining(mappedEncoded),
      expect.objectContaining({ cwd: "/home/user/workspace" }),
    );
  });
});

function buildProvider(client: TencentAgsxClientLike) {
  return new TencentAgsxSandboxProvider({
    client,
    apiKey: "e2b_test_key",
    domain: "ap-guangzhou.tencentags.com",
    codeTool: "delegate-code-v1",
  });
}

function buildClient(sandbox: TencentAgsxSandboxLike) {
  return {
    create: vi.fn(async () => sandbox),
    connect: vi.fn(async () => sandbox),
  } satisfies TencentAgsxClientLike;
}

function buildSandbox(output: { stdout?: string; stderr?: string } = {}): TencentAgsxSandboxLike {
  let stored = new Uint8Array();
  return {
    sandboxId: "tencent-sandbox-1",
    commands: {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: output.stdout ?? "ok",
        stderr: output.stderr ?? "",
      })),
    },
    files: {
      write: vi.fn(async (_path, data) => {
        stored = new Uint8Array(data.slice(0));
        return {};
      }),
      read: vi.fn(async () => stored),
    },
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
  };
}

function buildStartInput() {
  return {
    sandboxIdentityId: "identity-1",
    sandboxLeaseId: "lease-1",
    creationKey: "creation-key-1",
    runtimeClass: "code" as const,
    runnerType: "docker" as const,
    image: "debian:bookworm-slim",
    hostWorkspaceRoot: "/workspace",
    networkMode: "no_network" as const,
    filesystemMode: "ephemeral_full" as const,
    sessionId: "session-1",
  };
}

function buildLease() {
  return {
    id: "lease-1",
    provider: "tencent" as const,
    runnerType: "vm" as const,
    leaseId: "tencent-sandbox-1",
    providerSandboxId: "tencent-sandbox-1",
    containerId: "tencent-sandbox-1",
    containerName: "tencent-sandbox-1",
    sessionRoot: "/home/user/workspace",
  };
}
