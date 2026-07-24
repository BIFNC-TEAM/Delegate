import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  resolveWalletOperationId,
  runWalletWriteTransaction,
} from "../src/agent-wallet-write";

describe("agent wallet write guard", () => {
  it("uses Serializable transactions and retries Prisma write conflicts", async () => {
    let attempts = 0;
    const observedOptions: unknown[] = [];
    const transaction = vi.fn(
      async <T>(
        operation: (tx: unknown) => Promise<T>,
        options?: unknown,
      ): Promise<T> => {
        attempts += 1;
        observedOptions.push(options);
        if (attempts === 1) {
          throw prismaError("P2034");
        }
        return operation({});
      },
    );
    const client = { $transaction: transaction };

    await expect(
      runWalletWriteTransaction(client, async () => "saved"),
    ).resolves.toBe("saved");
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(observedOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
  });

  it("generates a distinct operation id when compatibility callers omit a key", () => {
    const first = resolveWalletOperationId(undefined, "agent_usage");
    const second = resolveWalletOperationId(undefined, "agent_usage");

    expect(first).toMatch(/^agent_usage:operation:/u);
    expect(second).toMatch(/^agent_usage:operation:/u);
    expect(second).not.toBe(first);
  });

  it("rejects a caller-provided empty idempotency key", () => {
    expect(() => resolveWalletOperationId("  ", "withdraw_request")).toThrow(
      "idempotencyKey must not be empty",
    );
  });
});

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("synthetic Prisma failure", {
    code,
    clientVersion: "test",
  });
}
