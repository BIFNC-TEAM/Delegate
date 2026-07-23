import { Prisma } from "@prisma/client";

const MAX_WRITE_CONFLICT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10;

export async function runWithPrismaWriteConflictRetry<T>(
  operation: () => Promise<T>,
  options: {
    retryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const retryDelayMs = Math.max(
    0,
    Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
  );
  const sleep = options.sleep ?? wait;

  for (let attempt = 1; attempt <= MAX_WRITE_CONFLICT_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isPrismaWriteConflict(error) || attempt === MAX_WRITE_CONFLICT_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error("Prisma write-conflict retry loop exhausted unexpectedly.");
}

function isPrismaWriteConflict(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2034";
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
