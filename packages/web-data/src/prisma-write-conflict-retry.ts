import { Prisma } from "@prisma/client";

const MAX_WRITE_CONFLICT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10;
const RETRYABLE_RAW_DATABASE_CODES = new Set(["40001", "40P01"]);

export async function runWithPrismaWriteConflictRetry<T>(
  operation: () => Promise<T>,
  options: {
    retryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    additionalRetryableCodes?: readonly string[];
  } = {},
): Promise<T> {
  const retryDelayMs = Math.max(
    0,
    Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
  );
  const sleep = options.sleep ?? wait;
  const retryableCodes = new Set([
    "P2034",
    ...(options.additionalRetryableCodes ?? []),
  ]);

  for (let attempt = 1; attempt <= MAX_WRITE_CONFLICT_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryablePrismaWriteError(error, retryableCodes) || attempt === MAX_WRITE_CONFLICT_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error("Prisma write-conflict retry loop exhausted unexpectedly.");
}

function isRetryablePrismaWriteError(
  error: unknown,
  retryableCodes: ReadonlySet<string>,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (retryableCodes.has(error.code)) return true;

  // Prisma wraps serialization failures and deadlocks raised by raw SQL as
  // P2010. Preserve the same retry semantics as P2034 without relying on a
  // localized error-message string.
  return error.code === "P2010"
    && typeof error.meta?.code === "string"
    && RETRYABLE_RAW_DATABASE_CODES.has(error.meta.code);
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
