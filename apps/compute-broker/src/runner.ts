import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ComputeFilesystemMode,
  ComputeNetworkMode,
  ComputeRunnerType,
} from "@delegate/compute-protocol";

const execFileAsync = promisify(execFile);
const SESSION_ROOT = "/delegate-session";

export type RunnerLeaseInput = {
  runnerType: ComputeRunnerType;
  image: string;
  hostWorkspaceRoot: string;
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
  sessionId: string;
};

export type RunnerLease = {
  runnerType: ComputeRunnerType;
  leaseId: string;
  containerId: string | null;
  containerName: string | null;
  sessionRoot: string;
};

export type RunnerExecutionInput = {
  runnerType: ComputeRunnerType;
  lease: RunnerLease;
  command: string;
  maxCommandSeconds: number;
  filesystemMode: ComputeFilesystemMode;
  workingDirectory?: string | null | undefined;
  sessionId: string;
  executionId: string;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
};

export type DockerExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  containerName: string;
  termination: "exit" | "command_timeout" | "output_limit";
};

export function buildDockerLeaseContainerName(sessionId: string) {
  return `delegate-lease-${normalizeDockerIdentifier(sessionId)}`;
}

export function buildDockerLeaseVolumeName(sessionId: string) {
  return `delegate-lease-vol-${normalizeDockerIdentifier(sessionId)}`;
}

export function buildDockerCreateLeaseArgs(input: Omit<RunnerLeaseInput, "runnerType">): string[] {
  const containerName = buildDockerLeaseContainerName(input.sessionId);
  const volumeName = buildDockerLeaseVolumeName(input.sessionId);
  const args = [
    "run",
    "-d",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--label",
    `delegate.session_id=${input.sessionId}`,
    "--label",
    "delegate.role=compute-lease",
    "--pids-limit",
    "128",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--volume",
    `${volumeName}:${SESSION_ROOT}:rw`,
    "--env",
    `DELEGATE_SESSION_ROOT=${SESSION_ROOT}`,
  ];

  if (input.networkMode === "no_network" || input.networkMode === "allowlist") {
    args.push("--network", "none");
  }

  const workspaceMode = normalizeFilesystemMode(input.filesystemMode);
  if (workspaceMode !== "ephemeral_full") {
    args.push(
      "--volume",
      `${input.hostWorkspaceRoot}:/workspace:${workspaceMode === "workspace_only" ? "rw" : "ro"}`,
    );
    args.push("--workdir", "/workspace");
  } else {
    args.push("--volume", `${volumeName}:/workspace:rw`);
    args.push("--workdir", "/workspace");
  }

  args.push(
    input.image,
    "sh",
    "-lc",
    "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
  );
  return args;
}

export function buildDockerExecArgs(input: {
  lease: RunnerLease;
  command: string;
  filesystemMode: ComputeFilesystemMode;
  workingDirectory?: string | null | undefined;
}): string[] {
  const containerName = input.lease.containerName ?? input.lease.containerId;
  if (!containerName) {
    throw new Error("Missing docker lease container handle.");
  }

  return [
    "exec",
    "--workdir",
    normalizeWorkingDirectory(input.filesystemMode, input.workingDirectory),
    "--env",
    `DELEGATE_SESSION_ROOT=${SESSION_ROOT}`,
    containerName,
    "sh",
    "-lc",
    input.command,
  ];
}

export async function acquireRunnerLease(input: RunnerLeaseInput): Promise<RunnerLease> {
  switch (input.runnerType) {
    case "docker":
      return acquireDockerLease(input);
    case "vm":
      throw new Error("VM runner is not implemented yet.");
    default:
      throw new Error(`Unsupported compute runner type: ${input.runnerType}`);
  }
}

export async function runRunnerExecution(
  input: RunnerExecutionInput,
): Promise<DockerExecutionResult> {
  switch (input.runnerType) {
    case "docker":
      return runDockerExecution(input);
    case "vm":
      throw new Error("VM runner is not implemented yet.");
    default:
      throw new Error(`Unsupported compute runner type: ${input.runnerType}`);
  }
}

export async function releaseRunnerLease(input: {
  runnerType: ComputeRunnerType;
  sessionId: string;
  leaseId?: string | null | undefined;
  containerId?: string | null | undefined;
}): Promise<void> {
  switch (input.runnerType) {
    case "docker":
      await releaseDockerLease(input);
      return;
    case "vm":
      throw new Error("VM runner is not implemented yet.");
    default:
      throw new Error(`Unsupported compute runner type: ${input.runnerType}`);
  }
}

async function acquireDockerLease(input: RunnerLeaseInput): Promise<RunnerLease> {
  const volumeName = buildDockerLeaseVolumeName(input.sessionId);
  const containerName = buildDockerLeaseContainerName(input.sessionId);

  await ensureDockerVolume(volumeName, input.sessionId);

  const existing = await inspectDockerContainer(containerName);
  if (existing?.running) {
    return {
      runnerType: "docker",
      leaseId: volumeName,
      containerId: existing.id,
      containerName,
      sessionRoot: SESSION_ROOT,
    };
  }

  if (existing) {
    await removeDockerContainer(containerName);
  }

  const args = buildDockerCreateLeaseArgs({
    image: input.image,
    hostWorkspaceRoot: input.hostWorkspaceRoot,
    networkMode: input.networkMode,
    filesystemMode: input.filesystemMode,
    sessionId: input.sessionId,
  });
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 1024 * 1024,
  });
  const containerId = stdout.trim() || containerName;

  return {
    runnerType: "docker",
    leaseId: volumeName,
    containerId,
    containerName,
    sessionRoot: SESSION_ROOT,
  };
}

async function runDockerExecution(
  input: RunnerExecutionInput,
): Promise<DockerExecutionResult> {
  const startedAt = Date.now();
  const containerName = input.lease.containerName ?? input.lease.containerId;
  if (!containerName) {
    throw new Error("Missing docker lease container handle.");
  }

  const args = buildDockerExecArgs({
    lease: input.lease,
    command: input.command,
    filesystemMode: input.filesystemMode,
    workingDirectory: input.workingDirectory,
  });

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: input.maxCommandSeconds * 1000,
      maxBuffer: Math.max(input.maxStdoutBytes ?? 1024 * 1024, input.maxStderrBytes ?? 1024 * 1024),
    });
    const boundedStdout = truncateUtf8(stdout, input.maxStdoutBytes);
    const boundedStderr = truncateUtf8(stderr, input.maxStderrBytes);
    const outputLimited = boundedStdout.truncated || boundedStderr.truncated;

    return {
      exitCode: outputLimited ? null : 0,
      stdout: boundedStdout.value,
      stderr: boundedStderr.value,
      wallMs: Date.now() - startedAt,
      containerName,
      termination: outputLimited ? "output_limit" : "exit",
    };
  } catch (error) {
    const timedOut = Boolean((error as { killed?: boolean }).killed);
    const maxBufferExceeded = (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    const exitCode =
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : timedOut
          ? null
          : 1;

    const rawStdout = String((error as { stdout?: string }).stdout ?? "");
    const rawStderr = String((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : ""));
    const stdout = truncateUtf8(rawStdout, input.maxStdoutBytes);
    const stderr = truncateUtf8(rawStderr, input.maxStderrBytes);
    const outputLimited = maxBufferExceeded || stdout.truncated || stderr.truncated;

    return {
      exitCode: timedOut || outputLimited ? null : exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      wallMs: Date.now() - startedAt,
      containerName,
      termination: timedOut ? "command_timeout" : outputLimited ? "output_limit" : "exit",
    };
  }
}

function truncateUtf8(value: string, maxBytes?: number) {
  if (!maxBytes) return { value, truncated: false };
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  return {
    value: encoded.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

async function releaseDockerLease(input: {
  sessionId: string;
  leaseId?: string | null | undefined;
  containerId?: string | null | undefined;
}) {
  const containerName = input.containerId || buildDockerLeaseContainerName(input.sessionId);
  const volumeName = input.leaseId || buildDockerLeaseVolumeName(input.sessionId);

  await removeDockerContainer(containerName);
  await removeDockerVolume(volumeName);
}

async function ensureDockerVolume(volumeName: string, sessionId: string) {
  const exists = await inspectDockerVolume(volumeName);
  if (exists) {
    return;
  }

  await execFileAsync("docker", [
    "volume",
    "create",
    "--label",
    `delegate.session_id=${sessionId}`,
    "--label",
    "delegate.role=compute-lease-volume",
    volumeName,
  ]);
}

async function inspectDockerVolume(volumeName: string) {
  try {
    await execFileAsync("docker", ["volume", "inspect", volumeName], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function inspectDockerContainer(containerName: string) {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "inspect",
        "--type=container",
        "--format",
        "{{.Id}}|{{.State.Running}}",
        containerName,
      ],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    const [id, runningValue] = stdout.trim().split("|");
    return {
      id: id || containerName,
      running: runningValue === "true",
    };
  } catch {
    return null;
  }
}

async function removeDockerContainer(containerName: string) {
  try {
    await execFileAsync("docker", ["rm", "-f", containerName], {
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Best-effort cleanup.
  }
}

async function removeDockerVolume(volumeName: string) {
  try {
    await execFileAsync("docker", ["volume", "rm", "-f", volumeName], {
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Best-effort cleanup.
  }
}

function normalizeWorkingDirectory(
  mode: ComputeFilesystemMode,
  value: string | null | undefined,
): string {
  if (mode === "ephemeral_full") {
    if (!value) {
      return SESSION_ROOT;
    }

    const normalized = value.startsWith("/") ? value : `${SESSION_ROOT}/${value}`;
    return normalized.startsWith(SESSION_ROOT) ? normalized : SESSION_ROOT;
  }

  if (!value) {
    return "/workspace";
  }

  if (value.startsWith(SESSION_ROOT)) {
    return value;
  }

  const normalized = value.startsWith("/") ? value : `/workspace/${value}`;
  return normalized.startsWith("/workspace") ? normalized : "/workspace";
}

function normalizeFilesystemMode(mode: ComputeFilesystemMode) {
  switch (mode) {
    case "workspace_only":
      return "workspace_only";
    case "ephemeral_full":
      return "ephemeral_full";
    case "read_only_workspace":
    default:
      return "read_only_workspace";
  }
}

function normalizeDockerIdentifier(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (normalized || "session").slice(0, 24);
}
