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

export type SandboxProviderKind = "docker" | "daytona";

export type SandboxProviderStartInput = RunnerLeaseInput & {
  sandboxIdentityId: string;
  sandboxLeaseId: string;
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
};

export type SandboxProviderStopInput = {
  lease: SandboxProviderLease;
  sessionId: string;
};

export type SandboxProviderDeleteInput = SandboxProviderStopInput;

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
  } | undefined;
  sandboxLifecycle?: {
    idleStopMinutes?: number | undefined;
    autoArchiveMinutes?: number | undefined;
    autoDeleteMinutes?: number | undefined;
  } | undefined;
};

export async function createSandboxProviderFromConfig(config: SandboxProviderConfig): Promise<{
  provider: SandboxProvider;
  providerKind: SandboxProviderKind;
}> {
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
  networkMode: ComputeNetworkMode;
  filesystemMode: ComputeFilesystemMode;
  hostWorkspaceRoot: string;
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
    executeCommand?: ((command: string) => Promise<DaytonaCommandResult>) | undefined;
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
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly startTimeoutSeconds: number;
  private readonly stopTimeoutSeconds: number;
  private readonly autostopMinutes?: number | undefined;
  private readonly autoArchiveMinutes?: number | undefined;
  private readonly autoDeleteMinutes?: number | undefined;

  constructor(options: DaytonaSandboxProviderOptions) {
    this.client = options.client;
    this.startTimeoutSeconds = options.startTimeoutSeconds ?? 60;
    this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? 60;
    this.autostopMinutes = options.autostopMinutes;
    this.autoArchiveMinutes = options.autoArchiveMinutes;
    this.autoDeleteMinutes = options.autoDeleteMinutes;
  }

  async start(input: SandboxProviderStartInput): Promise<SandboxProviderLease> {
    const labels = {
      "delegate.sandbox_identity_id": input.sandboxIdentityId,
      "delegate.sandbox_lease_id": input.sandboxLeaseId,
      "delegate.compute_session_id": input.sessionId,
      ...(input.labels ?? {}),
    };
    const sandbox = input.providerSandboxId
      ? await this.getExistingSandbox(input.providerSandboxId)
      : await this.client.create({
          image: input.image,
          labels,
          networkMode: input.networkMode,
          filesystemMode: input.filesystemMode,
          hostWorkspaceRoot: input.hostWorkspaceRoot,
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
    const result = await sandbox.process?.executeCommand?.(input.command);

    if (!result) {
      throw new Error("Daytona sandbox process execution is not available.");
    }

    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      stdout: result.stdout ?? result.result ?? "",
      stderr: result.stderr ?? "",
      wallMs: Math.max(1, Date.now() - startedAt),
      containerName: input.lease.containerName ?? input.lease.providerSandboxId ?? input.lease.id,
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
