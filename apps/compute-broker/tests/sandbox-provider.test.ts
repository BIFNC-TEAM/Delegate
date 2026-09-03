import { describe, expect, it, vi } from "vitest";

import {
  buildDaytonaNetworkSettings,
  createDockerSandboxProvider,
  DaytonaSandboxProvider,
  mapDaytonaError,
  SandboxProviderError,
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

  it("uses the default Daytona snapshot and creates /workspace for code sandboxes", async () => {
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
      language: "python",
      networkBlockAll: true,
      labels: expect.objectContaining({
        "delegate.sandbox_identity_id": "identity-1",
        "delegate.sandbox_lease_id": "lease-1",
      }),
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: -1,
    }), { timeoutSeconds: 60 });
    expect(client.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ image: expect.anything(), resources: expect.anything() }),
      { timeoutSeconds: 60 },
    );
    expect(sandbox.ensureWorkspace).toHaveBeenCalledOnce();
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ networkBlockAll: true });
    expect(sandbox.setLabels).toHaveBeenCalledWith(expect.objectContaining({
      "code-toolbox-language": "python",
      "delegate.sandbox_identity_id": "identity-1",
    }));
    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(15);
    expect(sandbox.setAutoArchiveInterval).toHaveBeenCalledWith(60);
    expect(sandbox.setAutoDeleteInterval).toHaveBeenCalledWith(-1);
    expect(lease).toMatchObject({
      id: "lease-1",
      provider: "daytona",
      providerSandboxId: "sandbox-1",
      sessionRoot: "/home/daytona/workspace",
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
      "/home/daytona/workspace/project",
      { DELEGATE_SESSION_ROOT: "/home/daytona/workspace" },
      9,
    );
    expect(sandbox.refreshActivity).toHaveBeenCalledOnce();

    await provider.execute({
      lease,
      runnerType: "vm",
      command: "pwd",
      maxCommandSeconds: 9,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
      executionId: "execution-2",
    });
    expect(sandbox.process?.executeCommand).toHaveBeenLastCalledWith(
      "pwd",
      "/home/daytona/workspace",
      { DELEGATE_SESSION_ROOT: "/home/daytona/workspace" },
      9,
    );

    await provider.execute({
      lease,
      runnerType: "vm",
      command: "pwd",
      maxCommandSeconds: 9,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      filesystemMode: "ephemeral_full",
      workingDirectory: "/tmp",
      sessionId: "session-1",
      executionId: "execution-3",
    });
    expect(sandbox.process?.executeCommand).toHaveBeenLastCalledWith(
      "pwd",
      "/tmp",
      { DELEGATE_SESSION_ROOT: "/home/daytona/workspace" },
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
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ networkBlockAll: true });
  });

  it("fails closed and deletes a new sandbox when tier policy blocks network overrides", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-tier-limited");
    sandbox.updateNetworkSettings = vi.fn(async () => {
      throw Object.assign(new Error(
        "Network access is restricted and cannot be overridden at the sandbox level.",
      ), { name: "DaytonaValidationError", statusCode: 400 });
    });
    const provider = new DaytonaSandboxProvider({
      client: { create: vi.fn(async () => sandbox) },
    });

    await expect(provider.start({
      sandboxIdentityId: "identity-tier-limited",
      sandboxLeaseId: "lease-tier-limited",
      runtimeClass: "code",
      runnerType: "vm",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-tier-limited",
    })).rejects.toMatchObject({ code: "POLICY_UNSUPPORTED", retryable: false });
    expect(sandbox.delete).toHaveBeenCalledWith(60, true);
    expect(sandbox.process?.executeCommand).not.toHaveBeenCalled();
  });

  it("supports browser sandboxes and splits CIDR/domain allowlists", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-browser");
    const client = { create: vi.fn(async () => sandbox) };
    const provider = new DaytonaSandboxProvider({
      client,
      resources: { cpu: 2, memory: 4, disk: 10 },
    });

    await provider.start({
      sandboxIdentityId: "identity-browser",
      sandboxLeaseId: "lease-browser",
      creationKey: "a".repeat(64),
      runtimeClass: "browser",
      runnerType: "vm",
      image: "playwright:latest",
      hostWorkspaceRoot: "/workspace",
      networkMode: "allowlist",
      networkAllowlist: ["example.com", "10.0.0.0/8", "*.daytona.io"],
      filesystemMode: "ephemeral_full",
      sessionId: "session-browser",
    });

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      name: `delegate-${"a".repeat(48)}`,
      image: "playwright:latest",
      resources: { cpu: 2, memory: 4, disk: 10 },
      networkBlockAll: false,
      networkAllowList: "10.0.0.0/8",
      domainAllowList: "*.daytona.io,example.com",
    }), { timeoutSeconds: 60 });
  });

  it("recovers a recoverable Daytona sandbox before reuse", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-recover");
    sandbox.state = "error";
    sandbox.recoverable = true;
    const provider = new DaytonaSandboxProvider({
      client: { get: vi.fn(async () => sandbox), create: vi.fn() },
    });

    await provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      providerSandboxId: "sandbox-recover",
      runnerType: "vm",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "full",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    });

    expect(sandbox.recover).toHaveBeenCalledWith(60);
    expect(sandbox.start).not.toHaveBeenCalled();
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ networkBlockAll: false });
  });

  it("recovers a deterministic Daytona create after a matching-name conflict", async () => {
    const creationKey = "b".repeat(64);
    const sandbox = createFakeDaytonaSandbox("sandbox-conflict");
    sandbox.labels = { "delegate.creation_key": creationKey };
    const conflict = Object.assign(new Error("already exists"), { statusCode: 409 });
    const client = {
      create: vi.fn(async () => { throw conflict; }),
      get: vi.fn(async () => sandbox),
    };
    const provider = new DaytonaSandboxProvider({ client });

    const lease = await provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      creationKey,
      runnerType: "vm",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    });

    expect(client.get).toHaveBeenCalledWith(`delegate-${"b".repeat(48)}`);
    expect(sandbox.start).toHaveBeenCalledWith(60);
    expect(lease.providerSandboxId).toBe("sandbox-conflict");
  });

  it("rejects a Daytona name conflict owned by another creation key", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-conflict");
    sandbox.labels = { "delegate.creation_key": "other" };
    const provider = new DaytonaSandboxProvider({
      client: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("already exists"), { statusCode: 409 });
        }),
        get: vi.fn(async () => sandbox),
      },
    });

    await expect(provider.start({
      sandboxIdentityId: "identity-1",
      sandboxLeaseId: "lease-1",
      creationKey: "c".repeat(64),
      runnerType: "vm",
      image: "debian:bookworm-slim",
      hostWorkspaceRoot: "/workspace",
      networkMode: "no_network",
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
    })).rejects.toMatchObject({ code: "CONFIG_INVALID", retryable: false });
  });

  it("fails closed when Daytona omits an execution exit code", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-1");
    sandbox.process!.executeCommand = vi.fn(async () => ({ result: "unknown" }));
    const provider = new DaytonaSandboxProvider({
      client: { get: vi.fn(async () => sandbox), create: vi.fn() },
    });
    const lease = buildDaytonaLease("sandbox-1");

    await expect(provider.execute({
      lease,
      runnerType: "vm",
      command: "echo unknown",
      maxCommandSeconds: 5,
      filesystemMode: "ephemeral_full",
      sessionId: "session-1",
      executionId: "execution-1",
    })).rejects.toMatchObject({ code: "REMOTE_5XX", retryable: true });
  });

  it("maps Daytona errors without exposing provider messages", () => {
    expect(mapDaytonaError(Object.assign(new Error("secret provider detail"), {
      name: "DaytonaRateLimitError",
      statusCode: 429,
    }), "execute")).toMatchObject({ code: "THROTTLED", retryable: true });
    expect(mapDaytonaError(Object.assign(new Error("deadline"), {
      name: "DaytonaTimeoutError",
    }), "create")).toMatchObject({ code: "AMBIGUOUS_CREATE", ambiguous: true });
    expect(mapDaytonaError(Object.assign(new Error("missing"), {
      statusCode: 404,
    }), "lifecycle")).toMatchObject({ code: "RUNTIME_NOT_FOUND" });
  });

  it("treats stop/delete of an already removed Daytona sandbox as idempotent", async () => {
    const missing = Object.assign(new Error("provider detail"), { statusCode: 404 });
    const provider = new DaytonaSandboxProvider({
      client: {
        get: vi.fn(async () => { throw missing; }),
        create: vi.fn(),
      },
    });
    const lease = buildDaytonaLease("missing");
    await expect(provider.stop({ lease, sessionId: "session-1" })).resolves.toBeUndefined();
    await expect(provider.delete({ lease, sessionId: "session-1" })).resolves.toBeUndefined();
  });

  it("waits for terminal Daytona deletion", async () => {
    const sandbox = createFakeDaytonaSandbox("sandbox-delete");
    const provider = new DaytonaSandboxProvider({
      client: { get: vi.fn(async () => sandbox), create: vi.fn() },
    });
    await provider.delete({ lease: buildDaytonaLease("sandbox-delete"), sessionId: "session-1" });
    expect(sandbox.delete).toHaveBeenCalledWith(60, true);
  });

  it("builds deterministic Daytona network settings", () => {
    expect(buildDaytonaNetworkSettings("no_network", [])).toEqual({ networkBlockAll: true });
    expect(buildDaytonaNetworkSettings("full", [])).toEqual({ networkBlockAll: false });
    expect(() => buildDaytonaNetworkSettings("allowlist", []))
      .toThrow(SandboxProviderError);
    expect(() => buildDaytonaNetworkSettings("allowlist", ["10.0.0.0/99"]))
      .toThrow(SandboxProviderError);
  });
});

function buildDaytonaLease(id: string) {
  return {
    id: `lease-${id}`,
    provider: "daytona" as const,
    runnerType: "vm" as const,
    leaseId: id,
    providerSandboxId: id,
    containerId: id,
    containerName: id,
    sessionRoot: "/workspace",
  };
}

function createFakeDaytonaSandbox(id: string): DaytonaSandboxLike {
  return {
    id,
    labels: { "code-toolbox-language": "python" },
    state: "stopped",
    start: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    refreshData: vi.fn(async () => undefined),
    refreshActivity: vi.fn(async () => undefined),
    updateNetworkSettings: vi.fn(async () => undefined),
    setLabels: vi.fn(async (labels) => labels),
    setAutostopInterval: vi.fn(async () => undefined),
    setAutoArchiveInterval: vi.fn(async () => undefined),
    setAutoDeleteInterval: vi.fn(async () => undefined),
    ensureWorkspace: vi.fn(async () => "/home/daytona/workspace"),
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
