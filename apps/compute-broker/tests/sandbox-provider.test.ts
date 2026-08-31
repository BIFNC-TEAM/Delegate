import { describe, expect, it, vi } from "vitest";

import {
  createDockerSandboxProvider,
  DaytonaSandboxProvider,
  type DaytonaSandboxLike,
} from "../src/sandbox-provider";

describe("sandbox provider contract", () => {
  it("keeps the docker provider compatible with existing runner leases", async () => {
    const acquire = vi.fn(async () => ({
      runnerType: "docker" as const,
      leaseId: "delegate-lease-vol-session-1",
      containerId: "container-1",
      containerName: "delegate-lease-session-1",
      sessionRoot: "/delegate-session",
    }));
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      wallMs: 12,
      containerName: "delegate-lease-session-1",
      termination: "exit" as const,
    }));
    const release = vi.fn(async () => undefined);
    const provider = createDockerSandboxProvider({ acquire, run, release });

    const lease = await provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      runnerType: "docker",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    });
    const result = await provider.execute({
      lease,
      runnerType: "docker",
      command: "echo ok",
      maxCommandSeconds: 5,
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
      executionId: "execution-1",
    });
    await provider.stop({ lease, sessionId: "session-1" });

    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "identity-1" }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ id: "lease-1" }) }));
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "identity-1" }));
    expect(lease).toMatchObject({
      id: "lease-1",
      provider: "docker",
      providerSandboxId: "identity-1",
      containerId: "container-1",
      sessionRoot: "/delegate-session",
    });
    expect(result.stdout).toBe("ok");
  });

  it("creates and configures a Daytona sandbox when no provider sandbox exists", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-1");
    const client = {
      create: vi.fn(async () => sandbox),
      get: vi.fn(async () => sandbox),
    };
    const provider = new DaytonaSandboxProvider({
      client,
      autostopMinutes: 15,
      autoArchiveMinutes: 60,
      autoDeleteMinutes: -1,
      resources: {
        cpu: 2,
        memory: 4,
        disk: 10,
      },
    });

    const lease = await provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      runnerType: "docker",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    });

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      image: "debian:bookworm-slim",
      networkBlockAll: true,
      labels: expect.objectContaining({
        "delegate.sandbox_identity_id": "identity-1",
        "delegate.sandbox_lease_id": "lease-1",
      }),
      resources: {
        cpu: 2,
        memory: 4,
        disk: 10,
      },
    }));
    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(15);
    expect(sandbox.setAutoArchiveInterval).toHaveBeenCalledWith(60);
    expect(sandbox.setAutoDeleteInterval).toHaveBeenCalledWith(-1);
    expect(lease).toMatchObject({
      id: "lease-1",
      provider: "daytona",
      providerSandboxId: "sandbox-1",
    });

    await provider.execute({
      lease,
      runnerType: "docker",
      command: "pwd",
      maxCommandSeconds: 9,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/workspace/project",
      sessionId: "session-1",
      executionId: "execution-1",
    });
    expect(sandbox.process?.executeCommand).toHaveBeenCalledWith(
      "pwd",
      "/workspace/project",
      { DELEGATE_SESSION_ROOT: "/workspace" },
      9,
    );
  });

  it("starts an existing Daytona sandbox instead of creating a new one", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-1");
    const client = {
      get: vi.fn(async () => sandbox),
      create: vi.fn(),
    };
    const provider = new DaytonaSandboxProvider({ client });

    await provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      providerSandboxId: "sandbox-1",
      runnerType: "docker",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    });

    expect(client.get).toHaveBeenCalledWith("sandbox-1");
    expect(client.create).not.toHaveBeenCalled();
    expect(sandbox.start).toHaveBeenCalledWith(60);
  });
});

function createFakeDaytonaSandbox(id: string): DaytonaSandboxLike {
  return {
    id,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    setLabels: vi.fn(async (labels) => labels),
    setAutostopInterval: vi.fn(async () => undefined),
    setAutoArchiveInterval: vi.fn(async () => undefined),
    setAutoDeleteInterval: vi.fn(async () => undefined),
    process: {
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        result: "ok",
      })),
    },
  };
}
