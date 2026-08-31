import type {
  ComputeFilesystemMode,
  ComputeNetworkMode,
  ComputeRunnerType,
} from "@delegate/compute-protocol";

import {
  acquireRunnerLease,
  releaseRunnerLease,
  runRunnerExecution,
  type DockerExecutionResult,
  type RunnerExecutionInput,
  type RunnerLease,
  type RunnerLeaseInput,
} from "./runner";
import type { SandboxProviderKind } from "./sandbox-routing";

export type { SandboxProviderKind } from "./sandbox-routing";
export type SandboxRuntimeClass = "code" | "browser";

export type SandboxProviderStartInput = RunnerLeaseInput & {
  sandboxIdentityId: string;
  sandboxLeaseId: string;
  creationKey?: string | undefined;
  runtimeClass?: SandboxRuntimeClass | undefined;
  providerSandboxId?: string | null | undefined;
  labels?: Record<string, string> | undefined;
};

export type SandboxProviderLease = RunnerLease & {
  id: string;
  provider: SandboxProviderKind;
  providerSandboxId: string | null;
};

export type SandboxProviderExecutionInput = Omit<RunnerExecutionInput, "lease"> & {
  lease: SandboxProviderLease;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
};

export type SandboxProviderStopInput = {
  lease: SandboxProviderLease;
  sessionId: string;
};

export type SandboxProviderDeleteInput = SandboxProviderStopInput;

export type SandboxProviderErrorCode =
  | "THROTTLED"
  | "TRANSPORT_TIMEOUT"
  | "REMOTE_5XX"
  | "AUTH_INVALID"
  | "CONFIG_INVALID"
  | "POLICY_UNSUPPORTED"
  | "RUNTIME_NOT_FOUND"
  | "COMMAND_TIMEOUT"
  | "AMBIGUOUS_CREATE"
  | "OUTPUT_LIMIT";

export class SandboxProviderError extends Error {
  readonly code: SandboxProviderErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(code: SandboxProviderErrorCode, retryable: boolean, ambiguous = false) {
    super(code.toLowerCase());
    this.name = "SandboxProviderError";
    this.code = code;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

export type SandboxProvider = {
  readonly kind: SandboxProviderKind;
  start(input: SandboxProviderStartInput): Promise<SandboxProviderLease>;
  execute(input: SandboxProviderExecutionInput): Promise<DockerExecutionResult>;
  stop(input: SandboxProviderStopInput): Promise<void>;
  delete(input: SandboxProviderDeleteInput): Promise<void>;
};

export type SandboxProviderConfig = {
  sandboxProvider: SandboxProviderKind;
  daytona?: {
    apiKey?: string | undefined;
    apiUrl?: string | undefined;
    target?: string | undefined;
    resources?: DaytonaSandboxResources | undefined;
  } | undefined;
  sandboxLifecycle?: {
    idleStopMinutes?: number | undefined;
    autoArchiveMinutes?: number | undefined;
    autoDeleteMinutes?: number | undefined;
  } | undefined;
  tencent?: {
    apiKey?: string | undefined;
    domain?: string | undefined;
    codeTool?: string | undefined;
  } | undefined;
};

export async function createSandboxProviderFromConfig(config: SandboxProviderConfig): Promise<{
  provider: SandboxProvider;
  providerKind: SandboxProviderKind;
}> {
  if (config.sandboxProvider === "tencent") {
    throw new Error("Tencent sandbox provider must be created through the provider registry.");
  }
  const daytonaApiKey = config.daytona?.apiKey;
  if (config.sandboxProvider === "daytona" && daytonaApiKey) {
    const client = await createDaytonaClientFromInstalledSdk({
      apiKey: daytonaApiKey,
      apiUrl: config.daytona?.apiUrl,
      target: config.daytona?.target,
    });
    return {
      provider: new DaytonaSandboxProvider({
        client,
        autostopMinutes: config.sandboxLifecycle?.idleStopMinutes,
        autoArchiveMinutes: config.sandboxLifecycle?.autoArchiveMinutes,
        autoDeleteMinutes: config.sandboxLifecycle?.autoDeleteMinutes,
        resources: config.daytona?.resources,
      }),
      providerKind: "daytona",
    };
  }

  return {
    provider: createDockerSandboxProvider(),
    providerKind: "docker",
  };
}

type DockerProviderDependencies = {
  acquire?: typeof acquireRunnerLease;
  run?: typeof runRunnerExecution;
  release?: typeof releaseRunnerLease;
};

export function createDockerSandboxProvider(
  dependencies: DockerProviderDependencies = {},
): SandboxProvider {
  const acquire = dependencies.acquire ?? acquireRunnerLease;
  const run = dependencies.run ?? runRunnerExecution;
  const release = dependencies.release ?? releaseRunnerLease;

  return {
    kind: "docker",
    async start(input) {
      const stableRuntimeId = input.providerSandboxId ?? input.sandboxIdentityId;
      const lease = await acquire({
        runnerType: input.runnerType,
        image: input.image,
        hostWorkspaceRoot: input.hostWorkspaceRoot,
        networkMode: input.networkMode,
        filesystemMode: input.filesystemMode,
        sessionId: stableRuntimeId,
      });

      return {
        ...lease,
        id: input.sandboxLeaseId,
        provider: "docker",
        providerSandboxId: stableRuntimeId,
      };
    },
    async execute(input) {
      return run({
        runnerType: input.runnerType,
        lease: input.lease,
        command: input.command,
        maxCommandSeconds: input.maxCommandSeconds,
        filesystemMode: input.filesystemMode,
        workingDirectory: input.workingDirectory,
        sessionId: input.sessionId,
        executionId: input.executionId,
        maxStdoutBytes: input.maxStdoutBytes,
        maxStderrBytes: input.maxStderrBytes,
      });
    },
    async stop(input) {
      await release({
        runnerType: input.lease.runnerType,
        sessionId: input.lease.providerSandboxId ?? input.sessionId,
        leaseId: input.lease.leaseId,
        containerId: input.lease.containerId,
      });
    },
    async delete(input) {
      await release({
        runnerType: input.lease.runnerType,
        sessionId: input.lease.providerSandboxId ?? input.sessionId,
        leaseId: input.lease.leaseId,
        containerId: input.lease.containerId,
      });
    },
  };
}

export async function createDaytonaClientFromInstalledSdk(config: {
  apiKey: string;
  apiUrl?: string | undefined;
  target?: string | undefined;
}): Promise<DaytonaClientLike> {
  const sdk = await importDaytonaSdk();
  const DaytonaCtor =
    getFunctionExport(sdk, "Daytona") ??
    getFunctionExport(sdk, "DaytonaClient") ??
    getFunctionExport(sdk, "default");

  if (!DaytonaCtor) {
    throw new Error("Daytona SDK did not expose a Daytona client constructor.");
  }

  const client = new DaytonaCtor({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { serverUrl: config.apiUrl, apiUrl: config.apiUrl } : {}),
    ...(config.target ? { target: config.target } : {}),
  });

  return {
    create(input) {
      return callDaytonaMethod(client, "create", input);
    },
    get(sandboxId) {
      return callDaytonaMethod(client, "get", sandboxId);
    },
  };
}

async function callDaytonaMethod(
  client: unknown,
  methodName: "create" | "get",
  input: unknown,
): Promise<DaytonaSandboxLike> {
  const candidates = [
    client,
    getObjectProperty(client, "sandboxes"),
    getObjectProperty(client, "sandbox"),
  ];

  for (const candidate of candidates) {
    const method = getFunctionProperty(candidate, methodName);
    if (method) {
      return method.call(candidate, input) as Promise<DaytonaSandboxLike>;
    }
  }

  throw new Error(`Daytona SDK client does not support ${methodName}.`);
}

function getFunctionExport(source: unknown, key: string): (new (input: unknown) => unknown) | null {
  const value = getObjectProperty(source, key);
  return typeof value === "function" ? (value as new (input: unknown) => unknown) : null;
}

function getFunctionProperty(source: unknown, key: string): ((input: unknown) => Promise<unknown>) | null {
  const value = getObjectProperty(source, key);
  return typeof value === "function" ? (value as (input: unknown) => Promise<unknown>) : null;
}

function getObjectProperty(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : null;
}

function importDynamic(specifier: string): Promise<Record<string, unknown>> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  return dynamicImport(specifier);
}

async function importDaytonaSdk(): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (const specifier of ["@daytona/sdk", "@daytonaio/sdk"]) {
    try {
      return await importDynamic(specifier);
    } catch (error) {
      errors.push(`${specifier}: ${error instanceof Error ? error.message : "module_not_available"}`);
    }
  }

  throw new Error(`Daytona SDK is not installed or could not be loaded: ${errors.join("; ")}`);
}

export type DaytonaCreateInput = {
  image: string;
  labels: Record<string, string>;
  networkBlockAll?: boolean | undefined;
  resources?: DaytonaSandboxResources | undefined;
};

export type DaytonaSandboxResources = {
  cpu?: number | undefined;
  memory?: number | undefined;
  disk?: number | undefined;
};

export type DaytonaCommandResult = {
  exitCode?: number | null | undefined;
  stdout?: string | null | undefined;
  stderr?: string | null | undefined;
  result?: string | null | undefined;
};

export type DaytonaSandboxLike = {
  id?: string | null | undefined;
  sandboxId?: string | null | undefined;
  instanceId?: string | null | undefined;
  start?: ((timeoutSeconds?: number) => Promise<unknown>) | undefined;
  stop?: ((timeoutSeconds?: number) => Promise<unknown>) | undefined;
  delete?: (() => Promise<unknown>) | undefined;
  remove?: (() => Promise<unknown>) | undefined;
  setLabels?: ((labels: Record<string, string>) => Promise<unknown>) | undefined;
  setAutostopInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  setAutoArchiveInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  setAutoDeleteInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  process?: {
    executeCommand?: ((
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSeconds?: number,
    ) => Promise<DaytonaCommandResult>) | undefined;
  } | undefined;
};

export type DaytonaClientLike = {
  create(input: DaytonaCreateInput): Promise<DaytonaSandboxLike>;
  get?: ((sandboxId: string) => Promise<DaytonaSandboxLike>) | undefined;
};

export type DaytonaSandboxProviderOptions = {
  client: DaytonaClientLike;
  startTimeoutSeconds?: number | undefined;
  stopTimeoutSeconds?: number | undefined;
  autostopMinutes?: number | undefined;
  autoArchiveMinutes?: number | undefined;
  autoDeleteMinutes?: number | undefined;
  resources?: DaytonaSandboxResources | undefined;
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly startTimeoutSeconds: number;
  private readonly stopTimeoutSeconds: number;
  private readonly autostopMinutes?: number | undefined;
  private readonly autoArchiveMinutes?: number | undefined;
  private readonly autoDeleteMinutes?: number | undefined;
  private readonly resources?: DaytonaSandboxResources | undefined;

  constructor(options: DaytonaSandboxProviderOptions) {
    this.client = options.client;
    this.startTimeoutSeconds = options.startTimeoutSeconds ?? 60;
    this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? 60;
    this.autostopMinutes = options.autostopMinutes;
    this.autoArchiveMinutes = options.autoArchiveMinutes;
    this.autoDeleteMinutes = options.autoDeleteMinutes;
    this.resources = options.resources;
  }

  async start(input: SandboxProviderStartInput): Promise<SandboxProviderLease> {
    if (input.runtimeClass && input.runtimeClass !== "code") {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    if (input.filesystemMode !== "ephemeral_full") {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    if (input.networkMode === "allowlist") {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    const labels = {
      "delegate.sandbox_identity_id": input.sandboxIdentityId,
      "delegate.sandbox_lease_id": input.sandboxLeaseId,
      "delegate.compute_session_id": input.sessionId,
      ...(input.creationKey ? { "delegate.creation_key": input.creationKey } : {}),
      "delegate.runtime_class": input.runtimeClass ?? "code",
      ...(input.labels ?? {}),
    };
    const sandbox = input.providerSandboxId
      ? await this.getExistingSandbox(input.providerSandboxId)
      : await this.client.create({
          image: input.image,
          labels,
          networkBlockAll: input.networkMode === "no_network",
          ...(this.resources ? { resources: this.resources } : {}),
        });

    if (input.providerSandboxId) {
      await sandbox.start?.(this.startTimeoutSeconds);
    }
    await sandbox.setLabels?.(labels);
    await this.configureLifecycle(sandbox);

    const providerSandboxId = resolveDaytonaSandboxId(sandbox, input.providerSandboxId);
    return {
      runnerType: input.runnerType,
      id: input.sandboxLeaseId,
      provider: "daytona",
      leaseId: providerSandboxId,
      providerSandboxId,
      containerId: providerSandboxId,
      containerName: providerSandboxId,
      sessionRoot: "/workspace",
    };
  }

  async execute(input: SandboxProviderExecutionInput): Promise<DockerExecutionResult> {
    const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
    const startedAt = Date.now();
    const result = await sandbox.process?.executeCommand?.(
      input.command,
      input.workingDirectory ?? "/workspace",
      { DELEGATE_SESSION_ROOT: "/workspace" },
      input.maxCommandSeconds,
    );

    if (!result) {
      throw new Error("Daytona sandbox process execution is not available.");
    }

    const stdout = truncateProviderOutput(result.stdout ?? result.result ?? "", input.maxStdoutBytes);
    const stderr = truncateProviderOutput(result.stderr ?? "", input.maxStderrBytes);
    const outputLimited = stdout.truncated || stderr.truncated;
    return {
      exitCode: outputLimited ? null : typeof result.exitCode === "number" ? result.exitCode : 0,
      stdout: stdout.value,
      stderr: stderr.value,
      wallMs: Math.max(1, Date.now() - startedAt),
      containerName: input.lease.containerName ?? input.lease.providerSandboxId ?? input.lease.id,
      termination: outputLimited ? "output_limit" : "exit",
    };
  }

  async stop(input: SandboxProviderStopInput): Promise<void> {
    const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
    await sandbox.stop?.(this.stopTimeoutSeconds);
  }

  async delete(input: SandboxProviderDeleteInput): Promise<void> {
    const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
    if (sandbox.delete) {
      await sandbox.delete();
      return;
    }
    await sandbox.remove?.();
  }

  private async getExistingSandbox(sandboxId: string): Promise<DaytonaSandboxLike> {
    if (!this.client.get) {
      throw new Error("Daytona provider cannot restore an existing sandbox without client.get.");
    }
    return this.client.get(sandboxId);
  }

  private async configureLifecycle(sandbox: DaytonaSandboxLike) {
    if (typeof this.autostopMinutes === "number") {
      await sandbox.setAutostopInterval?.(this.autostopMinutes);
    }
    if (typeof this.autoArchiveMinutes === "number") {
      await sandbox.setAutoArchiveInterval?.(this.autoArchiveMinutes);
    }
    if (typeof this.autoDeleteMinutes === "number") {
      await sandbox.setAutoDeleteInterval?.(this.autoDeleteMinutes);
    }
  }
}

function resolveDaytonaSandboxId(
  sandbox: DaytonaSandboxLike,
  fallback?: string | null | undefined,
): string {
  const id = sandbox.id ?? sandbox.sandboxId ?? sandbox.instanceId ?? fallback;
  if (!id) {
    throw new Error("Daytona sandbox did not return an id.");
  }
  return id;
}

function assertProviderSandboxId(lease: SandboxProviderLease): string {
  if (!lease.providerSandboxId) {
    throw new Error("Sandbox provider lease is missing providerSandboxId.");
  }
  return lease.providerSandboxId;
}

export function truncateProviderOutput(value: string, maxBytes?: number) {
  if (!maxBytes) return { value, truncated: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return {
    value: bytes.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}
