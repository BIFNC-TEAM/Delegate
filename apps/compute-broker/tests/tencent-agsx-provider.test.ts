import { describe, expect, it, vi } from "vitest";

import {
  mapTencentAgsxError,
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

  it("fails closed for browser, workspace mounts, or network access in Phase 1", async () => {
    const provider = buildProvider(buildClient(buildSandbox()));
    await expect(provider.start({ ...buildStartInput(), runtimeClass: "browser" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
    await expect(provider.start({ ...buildStartInput(), networkMode: "full" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
    await expect(provider.start({ ...buildStartInput(), filesystemMode: "workspace_only" }))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED" });
  });

  it("maps create timeouts to ambiguous outcomes without leaking provider text", () => {
    const mapped = mapTencentAgsxError(new Error("request timeout with secret=hidden"), true);
    expect(mapped).toMatchObject({ code: "AMBIGUOUS_CREATE", ambiguous: true });
    expect(mapped.message).toBe("ambiguous_create");
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
  return {
    sandboxId: "tencent-sandbox-1",
    commands: {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: output.stdout ?? "ok",
        stderr: output.stderr ?? "",
      })),
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
