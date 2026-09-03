import type {
  ComputeFilesystemMode,
  ComputeNetworkMode,
  ComputeRunnerType,
} from "@delegate/compute-protocol";
import type {
  CreateSandboxFromImageParams,
  Daytona as DaytonaSdkType,
  Sandbox as DaytonaSdkSandboxType,
} from "@daytona/sdk";
import { isIP } from "node:net";

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

type DaytonaSdkNetworkSettings = Parameters<DaytonaSdkSandboxType["updateNetworkSettings"]>[0];
const DAYTONA_WORKSPACE_ROOT = "/home/daytona/workspace";

export type { SandboxProviderKind } from "./sandbox-routing";
export type SandboxRuntimeClass = "code" | "browser";

export type SandboxProviderStartInput = RunnerLeaseInput & {
  sandboxIdentityId: string;
  sandboxLeaseId: string;
  creationKey?: string | undefined;
  runtimeClass?: SandboxRuntimeClass | undefined;
  providerSandboxId?: string | null | undefined;
  labels?: Record<string, string> | undefined;
  networkAllowlist?: readonly string[] | undefined;
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
    ttlMinutes?: number | undefined;
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
  if (config.sandboxProvider === "docker") {
    throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  }
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
        ttlMinutes: config.daytona?.ttlMinutes,
      }),
      providerKind: "daytona",
    };
  }

  throw new SandboxProviderError("AUTH_INVALID", false);
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
  const { Daytona } = await import("@daytona/sdk");
  const client: DaytonaSdkType = new Daytona({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    ...(config.target ? { target: config.target } : {}),
  });

  return {
    async create(input, options) {
      const sandbox = await client.create(input as CreateSandboxFromImageParams, {
        ...(typeof options?.timeoutSeconds === "number"
          ? { timeout: options.timeoutSeconds }
          : {}),
      });
      return adaptDaytonaSdkSandbox(sandbox);
    },
    async get(sandboxId) {
      return adaptDaytonaSdkSandbox(await client.get(sandboxId));
    },
  };
}

function adaptDaytonaSdkSandbox(sandbox: DaytonaSdkSandboxType): DaytonaSandboxLike {
  return {
    id: sandbox.id,
    labels: sandbox.labels,
    ...(sandbox.state ? { state: sandbox.state } : {}),
    ...(typeof sandbox.recoverable === "boolean"
      ? { recoverable: sandbox.recoverable }
      : {}),
    start: (timeoutSeconds) => sandbox.start(timeoutSeconds),
    recover: (timeoutSeconds) => sandbox.recover(timeoutSeconds),
    stop: (timeoutSeconds) => sandbox.stop(timeoutSeconds),
    delete: (timeoutSeconds, wait) => sandbox.delete(timeoutSeconds, wait),
    refreshData: () => sandbox.refreshData(),
    refreshActivity: () => sandbox.refreshActivity(),
    updateNetworkSettings: (settings) => sandbox.updateNetworkSettings(
      settings as DaytonaSdkNetworkSettings,
    ),
    setLabels: (labels) => sandbox.setLabels(labels),
    setAutostopInterval: (minutes) => sandbox.setAutostopInterval(minutes),
    setAutoArchiveInterval: (minutes) => sandbox.setAutoArchiveInterval(minutes),
    setAutoDeleteInterval: (minutes) => sandbox.setAutoDeleteInterval(minutes),
    ensureWorkspace: async () => {
      const home = await sandbox.getUserHomeDir();
      if (!home || !home.startsWith("/")) {
        throw new SandboxProviderError("CONFIG_INVALID", false);
      }
      try {
        await sandbox.fs.listFiles("workspace", { depth: 1 });
      } catch (error) {
        if (mapDaytonaError(error, "lifecycle").code !== "RUNTIME_NOT_FOUND") throw error;
        await sandbox.fs.createFolder("workspace", "755");
      }
      return `${home.replace(/\/+$/u, "")}/workspace`;
    },
    process: {
      executeCommand: (command, cwd, env, timeoutSeconds) =>
        sandbox.process.executeCommand(command, cwd, env, timeoutSeconds),
    },
  };
}

export type DaytonaCreateInput = {
  name?: string;
  image?: string;
  language?: "python";
  labels: Record<string, string>;
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  ttlMinutes?: number;
  resources?: DaytonaSandboxResources;
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
  artifacts?: { stdout?: string | null | undefined } | undefined;
};

export type DaytonaNetworkSettings = {
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
};

export type DaytonaSandboxLike = {
  id?: string | null | undefined;
  sandboxId?: string | null | undefined;
  instanceId?: string | null | undefined;
  state?: string | undefined;
  recoverable?: boolean | undefined;
  labels?: Record<string, string> | undefined;
  start?: ((timeoutSeconds?: number) => Promise<unknown>) | undefined;
  recover?: ((timeoutSeconds?: number) => Promise<unknown>) | undefined;
  stop?: ((timeoutSeconds?: number) => Promise<unknown>) | undefined;
  delete?: ((timeoutSeconds?: number, wait?: boolean) => Promise<unknown>) | undefined;
  remove?: (() => Promise<unknown>) | undefined;
  refreshData?: (() => Promise<unknown>) | undefined;
  refreshActivity?: (() => Promise<unknown>) | undefined;
  updateNetworkSettings?: ((settings: DaytonaNetworkSettings) => Promise<unknown>) | undefined;
  setLabels?: ((labels: Record<string, string>) => Promise<unknown>) | undefined;
  setAutostopInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  setAutoArchiveInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  setAutoDeleteInterval?: ((minutes: number) => Promise<unknown>) | undefined;
  ensureWorkspace?: (() => Promise<string>) | undefined;
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
  create(
    input: DaytonaCreateInput,
    options?: { timeoutSeconds?: number | undefined },
  ): Promise<DaytonaSandboxLike>;
  get?: ((sandboxId: string) => Promise<DaytonaSandboxLike>) | undefined;
};

export type DaytonaSandboxProviderOptions = {
  client: DaytonaClientLike;
  startTimeoutSeconds?: number | undefined;
  stopTimeoutSeconds?: number | undefined;
  autostopMinutes?: number | undefined;
  autoArchiveMinutes?: number | undefined;
  autoDeleteMinutes?: number | undefined;
  ttlMinutes?: number | undefined;
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
  private readonly ttlMinutes?: number | undefined;
  private readonly resources?: DaytonaSandboxResources | undefined;

  constructor(options: DaytonaSandboxProviderOptions) {
    this.client = options.client;
    this.startTimeoutSeconds = options.startTimeoutSeconds ?? 60;
    this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? 60;
    this.autostopMinutes = options.autostopMinutes;
    this.autoArchiveMinutes = options.autoArchiveMinutes;
    this.autoDeleteMinutes = options.autoDeleteMinutes;
    this.ttlMinutes = options.ttlMinutes;
    this.resources = options.resources;
  }

  async start(input: SandboxProviderStartInput): Promise<SandboxProviderLease> {
    if (input.filesystemMode !== "ephemeral_full") {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    const networkSettings = buildDaytonaNetworkSettings(
      input.networkMode,
      input.networkAllowlist ?? [],
    );
    const labels = {
      "delegate.sandbox_identity_id": input.sandboxIdentityId,
      "delegate.sandbox_lease_id": input.sandboxLeaseId,
      "delegate.compute_session_id": input.sessionId,
      ...(input.creationKey ? { "delegate.creation_key": input.creationKey } : {}),
      "delegate.runtime_class": input.runtimeClass ?? "code",
      ...(input.labels ?? {}),
    };
    const runtimeClass = input.runtimeClass ?? "code";
    let sandbox: DaytonaSandboxLike;
    let sessionRoot: string;
    let createdSandbox: DaytonaSandboxLike | null = null;
    try {
      const sandboxName = input.creationKey
        ? `delegate-${input.creationKey.slice(0, 48)}`
        : undefined;
      let restoring = Boolean(input.providerSandboxId);
      if (input.providerSandboxId) {
        sandbox = await this.getExistingSandbox(input.providerSandboxId);
      } else {
        try {
          sandbox = await this.client.create({
            ...(sandboxName ? { name: sandboxName } : {}),
            ...(runtimeClass === "browser"
              ? { image: input.image }
              : { language: "python" as const }),
            labels,
            ...networkSettings,
            ...(typeof this.autostopMinutes === "number"
              ? { autoStopInterval: this.autostopMinutes }
              : {}),
            ...(typeof this.autoArchiveMinutes === "number"
              ? { autoArchiveInterval: this.autoArchiveMinutes }
              : {}),
            ...(typeof this.autoDeleteMinutes === "number"
              ? { autoDeleteInterval: this.autoDeleteMinutes }
              : {}),
            ...(typeof this.ttlMinutes === "number"
              ? { ttlMinutes: this.ttlMinutes }
              : {}),
            ...(this.resources && runtimeClass === "browser"
              ? { resources: this.resources }
              : {}),
          }, { timeoutSeconds: this.startTimeoutSeconds });
          createdSandbox = sandbox;
        } catch (error) {
          if (!sandboxName || !isDaytonaConflictError(error)) throw error;
          sandbox = await this.getExistingSandbox(sandboxName);
          await sandbox.refreshData?.();
          if (sandbox.labels?.["delegate.creation_key"] !== input.creationKey) {
            throw new SandboxProviderError("CONFIG_INVALID", false);
          }
          restoring = true;
        }
      }

      if (restoring) {
        await restoreDaytonaSandbox(sandbox, this.startTimeoutSeconds);
      }
      await enforceDaytonaNetworkSettings(sandbox, networkSettings);
      if (!sandbox.ensureWorkspace) throw new SandboxProviderError("CONFIG_INVALID", false);
      sessionRoot = await sandbox.ensureWorkspace();
      await sandbox.setLabels?.({ ...(sandbox.labels ?? {}), ...labels });
      await this.configureLifecycle(sandbox);
    } catch (error) {
      const mapped = mapDaytonaError(error, input.providerSandboxId ? "lifecycle" : "create");
      if (createdSandbox?.delete) {
        await createdSandbox.delete(this.stopTimeoutSeconds, true).catch(() => undefined);
      }
      throw mapped;
    }

    const providerSandboxId = resolveDaytonaSandboxId(sandbox, input.providerSandboxId);
    return {
      runnerType: input.runnerType,
      id: input.sandboxLeaseId,
      provider: "daytona",
      leaseId: providerSandboxId,
      providerSandboxId,
      containerId: providerSandboxId,
      containerName: providerSandboxId,
      sessionRoot,
    };
  }

  async execute(input: SandboxProviderExecutionInput): Promise<DockerExecutionResult> {
    const startedAt = Date.now();
    let result: DaytonaCommandResult;
    try {
      const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
      await sandbox.refreshActivity?.();
      const sessionRoot = resolveDaytonaSessionRoot(input.lease.sessionRoot);
      const executed = await sandbox.process?.executeCommand?.(
        input.command,
        mapDaytonaWorkingDirectory(input.workingDirectory, sessionRoot),
        { DELEGATE_SESSION_ROOT: sessionRoot },
        input.maxCommandSeconds,
      );
      if (!executed || typeof executed.exitCode !== "number") {
        throw new SandboxProviderError("REMOTE_5XX", true);
      }
      result = executed;
    } catch (error) {
      throw mapDaytonaError(error, "execute");
    }

    const stdout = truncateProviderOutput(
      result.stdout ?? result.artifacts?.stdout ?? result.result ?? "",
      input.maxStdoutBytes,
    );
    const stderr = truncateProviderOutput(result.stderr ?? "", input.maxStderrBytes);
    const outputLimited = stdout.truncated || stderr.truncated;
    return {
      exitCode: outputLimited ? null : result.exitCode!,
      stdout: stdout.value,
      stderr: stderr.value,
      wallMs: Math.max(1, Date.now() - startedAt),
      containerName: input.lease.containerName ?? input.lease.providerSandboxId ?? input.lease.id,
      termination: outputLimited ? "output_limit" : "exit",
    };
  }

  async stop(input: SandboxProviderStopInput): Promise<void> {
    try {
      const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
      await sandbox.stop?.(this.stopTimeoutSeconds);
    } catch (error) {
      const mapped = mapDaytonaError(error, "lifecycle");
      if (mapped.code !== "RUNTIME_NOT_FOUND") throw mapped;
    }
  }

  async delete(input: SandboxProviderDeleteInput): Promise<void> {
    try {
      const sandbox = await this.getExistingSandbox(assertProviderSandboxId(input.lease));
      if (sandbox.delete) {
        await sandbox.delete(this.stopTimeoutSeconds, true);
        return;
      }
      await sandbox.remove?.();
    } catch (error) {
      const mapped = mapDaytonaError(error, "lifecycle");
      if (mapped.code !== "RUNTIME_NOT_FOUND") throw mapped;
    }
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

async function enforceDaytonaNetworkSettings(
  sandbox: DaytonaSandboxLike,
  settings: DaytonaNetworkSettings,
) {
  if (!sandbox.updateNetworkSettings) {
    throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  }
  try {
    await sandbox.updateNetworkSettings(settings);
  } catch (error) {
    const name = error instanceof Error ? error.name.toLowerCase() : "";
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (
      name.includes("validation")
      && message.includes("network access is restricted")
      && message.includes("cannot be overridden")
    ) {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    }
    throw error;
  }
}

function resolveDaytonaSessionRoot(value?: string | null) {
  return !value || value === "/workspace" ? DAYTONA_WORKSPACE_ROOT : value;
}

function mapDaytonaWorkingDirectory(value: string | null | undefined, sessionRoot: string) {
  const workingDirectory = value ?? "/workspace";
  if (workingDirectory === "/workspace") return sessionRoot;
  if (workingDirectory.startsWith("/workspace/")) {
    return `${sessionRoot}/${workingDirectory.slice("/workspace/".length)}`;
  }
  return workingDirectory;
}

function isDaytonaConflictError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.statusCode === 409
    || (error instanceof Error && error.name.toLowerCase().includes("conflict"));
}

async function restoreDaytonaSandbox(
  sandbox: DaytonaSandboxLike,
  timeoutSeconds: number,
) {
  await sandbox.refreshData?.();
  const state = sandbox.state?.toLowerCase();
  if (state === "destroyed" || state === "deleted") {
    throw new SandboxProviderError("RUNTIME_NOT_FOUND", false);
  }
  if (state === "error") {
    if (!sandbox.recoverable || !sandbox.recover) {
      throw new SandboxProviderError("REMOTE_5XX", true);
    }
    await sandbox.recover(timeoutSeconds);
    return;
  }
  if (state !== "started") {
    if (!sandbox.start) throw new SandboxProviderError("CONFIG_INVALID", false);
    await sandbox.start(timeoutSeconds);
  }
}

export function buildDaytonaNetworkSettings(
  mode: ComputeNetworkMode,
  allowlist: readonly string[],
): DaytonaNetworkSettings {
  if (mode === "no_network") return { networkBlockAll: true };
  if (mode === "full") return { networkBlockAll: false };
  const normalized = [...new Set(allowlist.map((entry) => entry.trim()).filter(Boolean))]
    .sort();
  if (!normalized.length) throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const entry of normalized) {
    const [address, prefix] = entry.split("/", 2);
    const ipVersion = isIP(address ?? "");
    const numericPrefix = prefix === undefined ? undefined : Number.parseInt(prefix, 10);
    const prefixValid = prefix === undefined || (
      /^\d{1,3}$/u.test(prefix)
      && numericPrefix! >= 0
      && numericPrefix! <= (ipVersion === 4 ? 32 : 128)
    );
    if (ipVersion && prefixValid) {
      cidrs.push(entry);
    } else if (entry.includes("/")) {
      throw new SandboxProviderError("POLICY_UNSUPPORTED", false);
    } else {
      domains.push(entry);
    }
  }
  return {
    networkBlockAll: false,
    ...(cidrs.length ? { networkAllowList: cidrs.join(",") } : {}),
    ...(domains.length ? { domainAllowList: domains.join(",") } : {}),
  };
}

export function mapDaytonaError(
  error: unknown,
  phase: "create" | "execute" | "lifecycle",
) {
  if (error instanceof SandboxProviderError) return error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (statusCode === 401 || statusCode === 403 || name.includes("authentication") || name.includes("authorization")) {
    return new SandboxProviderError("AUTH_INVALID", false);
  }
  if (statusCode === 404 || name.includes("notfound") || message.includes("not found")) {
    return new SandboxProviderError("RUNTIME_NOT_FOUND", false);
  }
  if (statusCode === 429 || name.includes("ratelimit") || message.includes("rate limit")) {
    return new SandboxProviderError("THROTTLED", true);
  }
  if (name.includes("timeout") || message.includes("timeout") || message.includes("deadline")) {
    return phase === "create"
      ? new SandboxProviderError("AMBIGUOUS_CREATE", false, true)
      : phase === "execute"
        ? new SandboxProviderError("COMMAND_TIMEOUT", false)
        : new SandboxProviderError("TRANSPORT_TIMEOUT", true);
  }
  if ((statusCode ?? 0) >= 500 || name.includes("connection") || message.includes("unavailable")) {
    return phase === "create"
      ? new SandboxProviderError("AMBIGUOUS_CREATE", false, true)
      : new SandboxProviderError("REMOTE_5XX", true);
  }
  return new SandboxProviderError("CONFIG_INVALID", false);
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
