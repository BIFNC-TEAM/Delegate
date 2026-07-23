export class McpBindingConflictError extends Error {
  readonly statusCode = 409;
  readonly publicMessage =
    "MCP binding changed since it was loaded. Refresh and retry.";

  constructor(message = "MCP binding changed since it was loaded. Refresh and retry.") {
    super(message);
    this.name = "McpBindingConflictError";
  }
}

export class McpBindingOperationError extends Error {
  readonly statusCode: 400 | 404;
  readonly publicMessage: string;

  constructor(
    message: string,
    statusCode: 400 | 404,
    publicMessage = message,
  ) {
    super(message);
    this.name = "McpBindingOperationError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export async function updateMcpBindingWithOptimisticLock<
  TBinding extends { updatedAt: Date },
>(input: {
  expectedUpdatedAt: string;
  loadCurrent: () => Promise<TBinding | null>;
  claimUpdate: (expectedUpdatedAt: Date) => Promise<{ count: number }>;
  loadUpdated: () => Promise<TBinding>;
}): Promise<{ previous: TBinding; updated: TBinding }> {
  const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
  if (Number.isNaN(expectedUpdatedAt.getTime())) {
    throw new McpBindingOperationError(
      "A valid expectedUpdatedAt timestamp is required when updating an MCP binding.",
      400,
    );
  }

  const previous = await input.loadCurrent();
  if (!previous) {
    throw new McpBindingOperationError(
      "MCP binding not found for this representative.",
      404,
    );
  }
  if (previous.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw new McpBindingConflictError();
  }

  const claimed = await input.claimUpdate(expectedUpdatedAt);
  if (claimed.count !== 1) {
    throw new McpBindingConflictError();
  }

  return {
    previous,
    updated: await input.loadUpdated(),
  };
}
