import type { Sandbox as E2BSandboxType } from "@e2b/code-interpreter";
import type { DockerExecutionResult } from "./runner";
import {
  SandboxProviderError,
  requireWorkspaceInputFileName,
  truncateProviderOutput,
  type SandboxProvider,
  type SandboxProviderExecutionInput,
  type SandboxProviderInputWriteInput,
  type SandboxProviderLease,
  type SandboxProviderStartInput,
} from "./sandbox-provider";

const TENCENT_WORKSPACE_ROOT = "/home/user/workspace";

export type TencentAgsxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TencentAgsxSandboxLike = {
  sandboxId: string;
  commands: {
    run(command: string, options: {
      cwd?: string | undefined;
      timeoutMs?: number | undefined;
      requestTimeoutMs?: number | undefined;
      onStdout?: ((data: string) => void | Promise<void>) | undefined;
      onStderr?: ((data: string) => void | Promise<void>) | undefined;
    }): Promise<TencentAgsxCommandResult>;
  };
  files: {
    write(path: string, data: ArrayBuffer, options?: {
      requestTimeoutMs?: number | undefined;
    }): Promise<unknown>;
    read(path: string, options: {
      format: "bytes";
      requestTimeoutMs?: number | undefined;
    }): Promise<Uint8Array>;
  };
  pause(options?: { keepMemory?: boolean | undefined }): Promise<boolean>;
  kill(): Promise<boolean>;
};

export type TencentAgsxClientLike = {
  create(input: {
    template: string;
    apiKey: string;
    domain: string;
    timeoutMs: number;
    allowInternetAccess: boolean;
    metadata: Record<string, string>;
  }): Promise<TencentAgsxSandboxLike>;
  connect(input: {
    sandboxId: string;
    apiKey: string;
    domain: string;
    timeoutMs: number;
  }): Promise<TencentAgsxSandboxLike>;
};

export type TencentAgsxSandboxProviderOptions = {
  client?: TencentAgsxClientLike | undefined;
  apiKey: string;
  domain: string;
  codeTool: string;
  sandboxTimeoutMs?: number | undefined;
};

export class TencentAgsxSandboxProvider implements SandboxProvider {
  readonly kind = "tencent" as const;
  private readonly client: TencentAgsxClientLike;
  private readonly apiKey: string;
  private readonly domain: string;
  private readonly codeTool: string;
  private readonly sandboxTimeoutMs: number;

  constructor(options: TencentAgsxSandboxProviderOptions) {
    this.client = options.client ?? createTencentAgsxSdkClient();
    this.apiKey = options.apiKey;
    this.domain = options.domain;
    this.codeTool = options.codeTool;
    this.sandboxTimeoutMs = options.sandboxTimeoutMs ?? 15 * 60 * 1000;
  }

  async start(input: SandboxProviderStartInput): Promise<SandboxProviderLease> {
    assertPhaseOneTencentPolicy(input);
    try {
      const sandbox = input.providerSandboxId
        ? await this.client.connect({
            sandboxId: input.providerSandboxId,
            apiKey: this.apiKey,
            domain: this.domain,
            timeoutMs: this.sandboxTimeoutMs,
          })
        : await this.client.create({
            template: this.codeTool,
            apiKey: this.apiKey,
            domain: this.domain,
            timeoutMs: this.sandboxTimeoutMs,
            allowInternetAccess: input.networkMode === "full",
            metadata: buildTencentMetadata(input),
          });

      const prepared = await sandbox.commands.run(`mkdir -p ${TENCENT_WORKSPACE_ROOT}`, {
        cwd: "/home/user",
        timeoutMs: 10_000,
        requestTimeoutMs: 15_000,
      });
      if (prepared.exitCode !== 0) {
        throw new SandboxProviderError("CONFIG_INVALID", false);
      }

      return {
        runnerType: input.runnerType,
        id: input.sandboxLeaseId,
        provider: "tencent",
        leaseId: sandbox.sandboxId,
        providerSandboxId: sandbox.sandboxId,
        containerId: sandbox.sandboxId,
        containerName: sandbox.sandboxId,
        sessionRoot: TENCENT_WORKSPACE_ROOT,
      };
    } catch (error) {
      throw mapTencentAgsxError(error, !input.providerSandboxId);
    }
  }

  async execute(input: SandboxProviderExecutionInput): Promise<DockerExecutionResult> {
    const providerSandboxId = requireProviderSandboxId(input.lease);
    const startedAt = Date.now();
    const stdoutCollector = createOutputCollector(input.maxStdoutBytes);
    const stderrCollector = createOutputCollector(input.maxStderrBytes);
    try {
      const sandbox = await this.client.connect({
        sandboxId: providerSandboxId,
        apiKey: this.apiKey,
        domain: this.domain,
        timeoutMs: this.sandboxTimeoutMs,
      });
      const result = await sandbox.commands.run(mapTencentCommand(input.command), {
        cwd: mapTencentWorkingDirectory(input.workingDirectory),
        timeoutMs: input.maxCommandSeconds * 1000,
        requestTimeoutMs: (input.maxCommandSeconds + 15) * 1000,
        onStdout: (data) => stdoutCollector.push(data),
        onStderr: (data) => stderrCollector.push(data),
      });
      const stdout = stdoutCollector.seen
        ? stdoutCollector.result()
        : truncateProviderOutput(result.stdout, input.maxStdoutBytes);
      const stderr = stderrCollector.seen
        ? stderrCollector.result()
        : truncateProviderOutput(result.stderr, input.maxStderrBytes);
      const outputLimited = stdout.truncated || stderr.truncated;
      return {
        exitCode: outputLimited ? null : result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        wallMs: Math.max(1, Date.now() - startedAt),
        containerName: providerSandboxId,
        termination: outputLimited ? "output_limit" : "exit",
      };
    } catch (error) {
      const mapped = mapTencentAgsxError(error, false);
      if (mapped.code === "COMMAND_TIMEOUT") {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          wallMs: Math.max(1, Date.now() - startedAt),
          containerName: providerSandboxId,
          termination: "command_timeout",
        };
      }
      if (mapped.code === "OUTPUT_LIMIT") {
        return {
          exitCode: null,
          stdout: stdoutCollector.result().value,
          stderr: stderrCollector.result().value,
          wallMs: Math.max(1, Date.now() - startedAt),
          containerName: providerSandboxId,
          termination: "output_limit",
        };
      }
      throw mapped;
    }
  }

  async writeInput(input: SandboxProviderInputWriteInput) {
    const providerSandboxId = requireProviderSandboxId(input.lease);
    const fileName = requireWorkspaceInputFileName(input.path);
    const remotePath = `${TENCENT_WORKSPACE_ROOT}/inputs/${fileName}`;
    const requestTimeoutMs = input.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    try {
      const sandbox = await this.client.connect({
        sandboxId: providerSandboxId,
        apiKey: this.apiKey,
        domain: this.domain,
        timeoutMs: this.sandboxTimeoutMs,
      });
      await sandbox.files.write(
        remotePath,
        Uint8Array.from(input.content).buffer,
        { requestTimeoutMs },
      );
      const verified = await sandbox.files.read(remotePath, {
        format: "bytes",
        requestTimeoutMs,
      });
      if (!Buffer.from(verified).equals(input.content)) {
        throw new SandboxProviderError("TRANSFER_INTEGRITY", false);
      }
      return { bytes: input.content.byteLength, durationMs: Date.now() - startedAt };
    } catch (error) {
      throw mapTencentAgsxError(error, false);
    }
  }

  async stop(input: { lease: SandboxProviderLease; sessionId: string }): Promise<void> {
    const providerSandboxId = requireProviderSandboxId(input.lease);
    try {
      const sandbox = await this.client.connect({
        sandboxId: providerSandboxId,
        apiKey: this.apiKey,
        domain: this.domain,
        timeoutMs: this.sandboxTimeoutMs,
      });
      await sandbox.pause({ keepMemory: false });
    } catch (error) {
      const mapped = mapTencentAgsxError(error, false);
      if (mapped.code !== "RUNTIME_NOT_FOUND") throw mapped;
    }
  }

  async delete(input: { lease: SandboxProviderLease; sessionId: string }): Promise<void> {
    const providerSandboxId = requireProviderSandboxId(input.lease);
    try {
      const sandbox = await this.client.connect({
        sandboxId: providerSandboxId,
        apiKey: this.apiKey,
        domain: this.domain,
        timeoutMs: this.sandboxTimeoutMs,
      });
      await sandbox.kill();
    } catch (error) {
      const mapped = mapTencentAgsxError(error, false);
      if (mapped.code !== "RUNTIME_NOT_FOUND") throw mapped;
    }
  }
}

export function createTencentAgsxSdkClient(): TencentAgsxClientLike {
  return {
    async create(input) {
      const { Sandbox } = await import("@e2b/code-interpreter");
      const sandbox = await Sandbox.create(input.template, {
        apiKey: input.apiKey,
        domain: input.domain,
        timeoutMs: input.timeoutMs,
        allowInternetAccess: input.allowInternetAccess,
        metadata: input.metadata,
      });
      return adaptE2BSandbox(sandbox);
    },
    async connect(input) {
      const { Sandbox } = await import("@e2b/code-interpreter");
      const sandbox = await Sandbox.connect(input.sandboxId, {
        apiKey: input.apiKey,
        domain: input.domain,
        timeoutMs: input.timeoutMs,
      });
      return adaptE2BSandbox(sandbox);
    },
  };
}

function adaptE2BSandbox(sandbox: E2BSandboxType): TencentAgsxSandboxLike {
  return {
    sandboxId: sandbox.sandboxId,
    commands: {
      async run(command, options) {
        try {
          return await sandbox.commands.run(command, {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
            ...(typeof options.requestTimeoutMs === "number"
              ? { requestTimeoutMs: options.requestTimeoutMs }
              : {}),
            ...(options.onStdout ? { onStdout: options.onStdout } : {}),
            ...(options.onStderr ? { onStderr: options.onStderr } : {}),
          });
        } catch (error) {
          const commandExit = readTencentCommandExitResult(error);
          if (commandExit) return commandExit;
          throw error;
        }
      },
    },
    files: {
      write(path, data, options) {
        return sandbox.files.write(path, data, {
          ...(typeof options?.requestTimeoutMs === "number"
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
        });
      },
      read(path, options) {
        return sandbox.files.read(path, {
          format: "bytes",
          ...(typeof options.requestTimeoutMs === "number"
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
        });
      },
    },
    pause(options) {
      return sandbox.pause(options?.keepMemory === undefined ? undefined : { keepMemory: options.keepMemory });
    },
    kill() {
      return sandbox.kill();
    },
  };
}

export function readTencentCommandExitResult(error: unknown): TencentAgsxCommandResult | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (
    record.name !== "CommandExitError"
    || typeof record.exitCode !== "number"
  ) return null;
  return {
    exitCode: record.exitCode,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
  };
}

function assertPhaseOneTencentPolicy(input: SandboxProviderStartInput) {
  if ((input.runtimeClass ?? "code") !== "code") {
    throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  }
  if (
    input.filesystemMode !== "ephemeral_full"
    || !["no_network", "full"].includes(input.networkMode)
  ) {
    throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  }
}

function buildTencentMetadata(input: SandboxProviderStartInput) {
  return {
    "delegate.sandbox_identity_id": input.sandboxIdentityId,
    "delegate.sandbox_lease_id": input.sandboxLeaseId,
    "delegate.creation_key": input.creationKey ?? input.sandboxLeaseId,
    "delegate.runtime_class": input.runtimeClass ?? "code",
  };
}

function requireProviderSandboxId(lease: SandboxProviderLease) {
  if (!lease.providerSandboxId) throw new SandboxProviderError("RUNTIME_NOT_FOUND", false);
  return lease.providerSandboxId;
}

function mapTencentWorkingDirectory(value: string | null | undefined) {
  const workingDirectory = value ?? "/workspace";
  if (workingDirectory === "/workspace") return TENCENT_WORKSPACE_ROOT;
  if (workingDirectory.startsWith("/workspace/")) {
    return `${TENCENT_WORKSPACE_ROOT}/${workingDirectory.slice("/workspace/".length)}`;
  }
  return workingDirectory;
}

function mapTencentCommand(command: string) {
  const rewrittenInlineProgram = command.replace(
    /'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?'/gu,
    (quoted) => {
      const encoded = quoted.slice(1, -1);
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        if (!decoded.includes("/workspace")) return quoted;
        const rewritten = rewriteTencentWorkspacePaths(decoded);
        return `'${Buffer.from(rewritten, "utf8").toString("base64")}'`;
      } catch {
        return quoted;
      }
    },
  );
  return rewriteTencentWorkspacePaths(rewrittenInlineProgram);
}

function rewriteTencentWorkspacePaths(value: string) {
  return value.replace(/(?<!\/home\/user)\/workspace/gu, TENCENT_WORKSPACE_ROOT);
}

export function mapTencentAgsxError(error: unknown, creating: boolean) {
  if (error instanceof SandboxProviderError) return error;
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name.includes("authentication") || message.includes("unauthorized") || message.includes("forbidden")) {
    return new SandboxProviderError("AUTH_INVALID", false);
  }
  if (name.includes("ratelimit") || message.includes("rate limit") || message.includes("429")) {
    return new SandboxProviderError("THROTTLED", true);
  }
  if (name.includes("notfound") || message.includes("not found") || message.includes("404")) {
    return new SandboxProviderError("RUNTIME_NOT_FOUND", false);
  }
  if (name.includes("timeout") || message.includes("deadline") || message.includes("timeout")) {
    return creating
      ? new SandboxProviderError("AMBIGUOUS_CREATE", false, true)
      : new SandboxProviderError("COMMAND_TIMEOUT", false);
  }
  if (/\b5\d\d\b/u.test(message) || message.includes("unavailable")) {
    return creating
      ? new SandboxProviderError("AMBIGUOUS_CREATE", false, true)
      : new SandboxProviderError("REMOTE_5XX", true);
  }
  return creating
    ? new SandboxProviderError("AMBIGUOUS_CREATE", false, true)
    : new SandboxProviderError("CONFIG_INVALID", false);
}

function createOutputCollector(maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let truncated = false;
  let seen = false;
  return {
    get seen() {
      return seen;
    },
    push(value: string) {
      seen = true;
      const bytes = Buffer.from(value, "utf8");
      const remaining = Math.max(0, maxBytes - byteLength);
      if (remaining > 0) {
        const accepted = bytes.subarray(0, remaining);
        chunks.push(accepted);
        byteLength += accepted.byteLength;
      }
      if (bytes.byteLength > remaining) {
        truncated = true;
        throw new SandboxProviderError("OUTPUT_LIMIT", false);
      }
    },
    result() {
      return {
        value: Buffer.concat(chunks).toString("utf8"),
        truncated,
      };
    },
  };
}
