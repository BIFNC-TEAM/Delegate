import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { runWithPrismaWriteConflictRetry } from "../src/prisma-write-conflict-retry";

describe("Prisma write-conflict retry", () => {
  it("retries P2034 twice with bounded backoff before succeeding", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockResolvedValue("saved");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runWithPrismaWriteConflictRetry(operation, {
      retryDelayMs: 10,
      sleep,
    })).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("stops after three total attempts", async () => {
    const conflict = prismaError("P2034");
    const operation = vi.fn().mockRejectedValue(conflict);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runWithPrismaWriteConflictRetry(operation, {
      retryDelayMs: 10,
      sleep,
    })).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("does not retry non-conflict failures", async () => {
    const failure = prismaError("P2002");
    const operation = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runWithPrismaWriteConflictRetry(operation, {
      sleep,
    })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("can retry an explicitly allowed unique-key race", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(prismaError("P2002"))
      .mockResolvedValue("replayed");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runWithPrismaWriteConflictRetry(operation, {
      additionalRetryableCodes: ["P2002"],
      sleep,
    })).resolves.toBe("replayed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each(["40001", "40P01"])(
    "retries raw PostgreSQL write conflict %s wrapped as P2010",
    async (databaseCode) => {
      const operation = vi.fn()
        .mockRejectedValueOnce(prismaRawError(databaseCode))
        .mockResolvedValue("replayed");
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(runWithPrismaWriteConflictRetry(operation, {
        sleep,
      })).resolves.toBe("replayed");
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );
});

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("synthetic Prisma failure", {
    code,
    clientVersion: "test",
  });
}

function prismaRawError(databaseCode: string) {
  return new Prisma.PrismaClientKnownRequestError("synthetic raw failure", {
    code: "P2010",
    clientVersion: "test",
    meta: {
      code: databaseCode,
      message: "synthetic PostgreSQL write conflict",
    },
  });
}
