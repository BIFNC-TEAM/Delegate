import {
  buildGovernedMemoryManagedUserId,
  OpenVikingClient,
  OpenVikingRequestError,
  resolveOpenVikingEnv,
} from "@delegate/openviking";

export type MemoryProjectionProviderEnsureInput = {
  namespaceKey: string;
  rootUri: string;
};

export type MemoryProjectionProviderWriteInput = {
  namespaceKey: string;
  uri: string;
  safeText: string;
  contentHash: string;
};

export type MemoryProjectionProviderExactInput = {
  namespaceKey: string;
  uri: string;
};

/**
 * Deliberately narrow provider boundary for governed memory. Implementations
 * can provision only the validated managed-user root and can write/read/delete
 * only one immutable version leaf. Generic mkdir, arbitrary write, recursive
 * delete, and search APIs are intentionally absent.
 */
export interface MemoryProjectionProvider {
  readonly name: string;
  ensureRoot(input: MemoryProjectionProviderEnsureInput): Promise<{
    rootUri: string;
    receipt: string;
  }>;
  writeExact(input: MemoryProjectionProviderWriteInput): Promise<{
    uri: string;
    contentHash: string;
    receipt: string;
  }>;
  inspectExact(input: MemoryProjectionProviderExactInput): Promise<{
    uri: string;
    exists: boolean;
    contentHash?: string;
    receipt: string;
  }>;
  deleteExact(input: MemoryProjectionProviderExactInput): Promise<{
    uri: string;
    outcome: "deleted" | "absent";
    receipt: string;
  }>;
}

export class MemoryProjectionProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly cleanupRequired = false,
  ) {
    super(message);
    this.name = "MemoryProjectionProviderError";
  }
}

/**
 * OpenViking adapter that always scopes all operations to the managed user
 * derived from namespaceKey. Public-knowledge and representative clients must
 * never be passed through this boundary.
 */
export class OpenVikingMemoryProjectionProvider implements MemoryProjectionProvider {
  readonly name = "openviking";

  constructor(private readonly client: OpenVikingClient) {}

  async ensureRoot(input: MemoryProjectionProviderEnsureInput) {
    const client = this.scopedClient(input.namespaceKey);
    const result = await client.ensureGovernedMemoryRoot({
      namespaceKey: input.namespaceKey,
      uri: input.rootUri,
    });
    return {
      rootUri: result.rootUri,
      receipt: stableReceipt({
        operation: "ensure_root",
        rootUri: result.rootUri,
        outcome: result.outcome,
      }),
    };
  }

  async writeExact(input: MemoryProjectionProviderWriteInput) {
    const client = this.scopedClient(input.namespaceKey);
    const result = await client.createGovernedMemoryVersion(input);
    return {
      uri: result.uri,
      contentHash: result.contentHash,
      receipt: stableReceipt({
        operation: "write_exact",
        uri: result.uri,
        contentHash: result.contentHash,
        outcome: result.outcome,
      }),
    };
  }

  async inspectExact(input: MemoryProjectionProviderExactInput) {
    const client = this.scopedClient(input.namespaceKey);
    try {
      const result = await client.readGovernedMemoryVersion(input);
      return {
        uri: result.uri,
        exists: true,
        contentHash: result.contentHash,
        receipt: stableReceipt({
          operation: "inspect_exact",
          uri: result.uri,
          outcome: "present",
          contentHash: result.contentHash,
        }),
      };
    } catch (error) {
      if (error instanceof OpenVikingRequestError && error.status === 404) {
        return {
          uri: input.uri,
          exists: false,
          receipt: stableReceipt({
            operation: "inspect_exact",
            uri: input.uri,
            outcome: "absent",
          }),
        };
      }
      throw error;
    }
  }

  async deleteExact(input: MemoryProjectionProviderExactInput) {
    const client = this.scopedClient(input.namespaceKey);
    try {
      const result = await client.deleteGovernedMemoryVersion(input);
      return {
        uri: result.uri,
        outcome: "deleted" as const,
        receipt: stableReceipt({
          operation: "delete_exact",
          uri: result.uri,
          outcome: "deleted",
        }),
      };
    } catch (error) {
      if (error instanceof OpenVikingRequestError && error.status === 404) {
        return {
          uri: input.uri,
          outcome: "absent" as const,
          receipt: stableReceipt({
            operation: "delete_exact",
            uri: input.uri,
            outcome: "already_absent",
          }),
        };
      }
      throw error;
    }
  }

  private scopedClient(namespaceKey: string) {
    return this.client.withScope({
      userId: buildGovernedMemoryManagedUserId(namespaceKey),
    });
  }
}

export function createDefaultMemoryProjectionProvider(): MemoryProjectionProvider | null {
  const env = resolveOpenVikingEnv();
  if (!env.enabled) return null;
  return new OpenVikingMemoryProjectionProvider(new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    // Every operation overrides this bootstrap identity with the canonical
    // namespace-managed user before any request is made.
    userId: "delegate-memory-bootstrap",
  }));
}

export function defaultMemoryProjectionProviderIsEnabled() {
  return resolveOpenVikingEnv().enabled;
}

function stableReceipt(value: Record<string, unknown>) {
  return JSON.stringify(value);
}
