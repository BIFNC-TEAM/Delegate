import {
  createDaytonaClientFromInstalledSdk,
  createDockerSandboxProvider,
  DaytonaSandboxProvider,
  SandboxProviderError,
  type DaytonaSandboxResources,
  type SandboxProvider,
} from "./sandbox-provider";
import {
  cloudSandboxProviderKinds,
  type CloudSandboxProviderKind,
  type SandboxProviderKind,
} from "./sandbox-routing";
import { TencentAgsxSandboxProvider } from "./tencent-agsx-provider";

export type SandboxProviderRegistryConfig = {
  legacyProvider: SandboxProviderKind;
  sandboxLifecycle: {
    idleStopMinutes: number;
    autoArchiveMinutes: number;
    autoDeleteMinutes: number;
  };
  daytona: {
    apiKey?: string | undefined;
    apiUrl?: string | undefined;
    target?: string | undefined;
    resources?: DaytonaSandboxResources | undefined;
    ttlMinutes?: number | undefined;
  };
  tencent: {
    apiKey?: string | undefined;
    domain?: string | undefined;
    codeTool?: string | undefined;
  };
};

export class SandboxProviderRegistry {
  private readonly config: SandboxProviderRegistryConfig;

  constructor(config: SandboxProviderRegistryConfig) {
    this.config = config;
  }

  async create(providerKind: SandboxProviderKind): Promise<SandboxProvider> {
    if (providerKind === "docker") return createDockerSandboxProvider();
    if (providerKind === "daytona") {
      const apiKey = this.config.daytona.apiKey;
      if (!apiKey) throw new SandboxProviderError("AUTH_INVALID", false);
      const client = await createDaytonaClientFromInstalledSdk({
        apiKey,
        apiUrl: this.config.daytona.apiUrl,
        target: this.config.daytona.target,
      });
      return new DaytonaSandboxProvider({
        client,
        autostopMinutes: this.config.sandboxLifecycle.idleStopMinutes,
        autoArchiveMinutes: this.config.sandboxLifecycle.autoArchiveMinutes,
        autoDeleteMinutes: this.config.sandboxLifecycle.autoDeleteMinutes,
        resources: this.config.daytona.resources,
        ttlMinutes: this.config.daytona.ttlMinutes,
      });
    }

    const { apiKey, domain, codeTool } = this.config.tencent;
    if (!apiKey || !domain || !codeTool) {
      throw new SandboxProviderError("CONFIG_INVALID", false);
    }
    return new TencentAgsxSandboxProvider({
      apiKey,
      domain,
      codeTool,
      sandboxTimeoutMs: this.config.sandboxLifecycle.idleStopMinutes * 60 * 1000,
    });
  }

  configured(providerKind: SandboxProviderKind) {
    if (providerKind === "docker") return true;
    if (providerKind === "daytona") return Boolean(this.config.daytona.apiKey);
    return Boolean(this.config.tencent.apiKey && this.config.tencent.domain && this.config.tencent.codeTool);
  }

  resolveLegacyProvider(): CloudSandboxProviderKind {
    const preferred = this.config.legacyProvider === "docker"
      ? []
      : [this.config.legacyProvider];
    const provider = [...preferred, ...cloudSandboxProviderKinds]
      .find((candidate, index, values) =>
        values.indexOf(candidate) === index && this.configured(candidate));
    if (!provider) throw new SandboxProviderError("CONFIG_INVALID", false);
    return provider;
  }
}
