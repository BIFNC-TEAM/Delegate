type TelegramMessageLike = {
  text?: string;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
};

type TelegramUpdateLike = {
  update_id: number;
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  callback_query?: unknown;
  pre_checkout_query?: unknown;
};

export type TelegramRuntimeConfig = {
  apiTimeoutSeconds: number;
  pollingTimeoutSeconds: number;
};

export type TelegramChannelBindingSnapshot = {
  id: string;
  transport: "TELEGRAM" | "MATRIX" | "WEB" | null;
  sourceProvider: "TELEGRAM" | "MATRIX" | "WEB" | null;
  connectionId: string | null;
};

export type TelegramUpdateMetadata = {
  updateId: number;
  type: "message" | "edited_message" | "callback_query" | "pre_checkout_query" | "other";
  command?: string;
  synthesizedCommandEntity?: true;
};

export class TelegramRepresentativeSessionUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Unable to read the active Telegram representative session.");
    this.name = "TelegramRepresentativeSessionUnavailableError";
    this.cause = cause;
  }
}

type TelegramUpdateLogger = Pick<Console, "info" | "error">;
type TelegramMiddlewareErrorLogger = Pick<Console, "error">;
type TelegramMiddlewareErrorContext = {
  update: {
    update_id: number;
  };
  reply: (text: string) => Promise<unknown>;
};

const loggedTelegramCommands = new Set([
  "start",
  "plans",
  "buy",
  "paysupport",
  "bind",
  "compute",
]);
const defaultTelegramRequestTimeoutMs = 15_000;
const minimumTelegramRequestTimeoutMs = 3_000;
const maximumTelegramRequestTimeoutMs = 60_000;
const maximumPollingTimeoutSeconds = 10;

export function planTelegramBotChannelBindingSynchronization(
  bindings: TelegramChannelBindingSnapshot[],
  connectionId: string,
): {
  updateBindingIds: string[];
  conflictingBindingIds: string[];
} {
  const normalizedConnectionId = connectionId.trim();
  const updateBindingIds: string[] = [];
  const conflictingBindingIds: string[] = [];

  for (const binding of bindings) {
    const isDirectTelegramBinding =
      (binding.transport === null || binding.transport === "TELEGRAM")
      && (
        binding.sourceProvider === null
        || binding.sourceProvider === "TELEGRAM"
      );
    if (!isDirectTelegramBinding) {
      continue;
    }

    const existingConnectionId = binding.connectionId?.trim() || null;
    if (
      existingConnectionId
      && existingConnectionId !== normalizedConnectionId
    ) {
      conflictingBindingIds.push(binding.id);
      continue;
    }
    updateBindingIds.push(binding.id);
  }

  return { updateBindingIds, conflictingBindingIds };
}

export function resolveTelegramRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramRuntimeConfig {
  const rawValue =
    env.TELEGRAM_REQUEST_TIMEOUT_MS?.trim()
    || String(defaultTelegramRequestTimeoutMs);
  const requestTimeoutMs = Number(rawValue);

  if (
    !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < minimumTelegramRequestTimeoutMs
    || requestTimeoutMs > maximumTelegramRequestTimeoutMs
  ) {
    throw new Error(
      `TELEGRAM_REQUEST_TIMEOUT_MS must be an integer between ${minimumTelegramRequestTimeoutMs} and ${maximumTelegramRequestTimeoutMs}.`,
    );
  }

  const apiTimeoutSeconds = Math.ceil(requestTimeoutMs / 1_000);
  return {
    apiTimeoutSeconds,
    pollingTimeoutSeconds: Math.max(
      1,
      Math.min(maximumPollingTimeoutSeconds, apiTimeoutSeconds - 2),
    ),
  };
}

export async function resolveTelegramRepresentativeSession(params: {
  chatType: string;
  defaultRepresentativeSlug: string;
  readActiveRepresentativeSlug: () => Promise<string | null>;
}): Promise<string> {
  if (params.chatType !== "private") {
    return params.defaultRepresentativeSlug;
  }

  try {
    return (
      (await params.readActiveRepresentativeSlug())
      ?? params.defaultRepresentativeSlug
    );
  } catch (error) {
    throw new TelegramRepresentativeSessionUnavailableError(error);
  }
}

export function isTelegramRepresentativeSessionUnavailableError(
  error: unknown,
): error is TelegramRepresentativeSessionUnavailableError {
  return error instanceof TelegramRepresentativeSessionUnavailableError;
}

export async function handleTelegramMiddlewareError(params: {
  error: unknown;
  context: TelegramMiddlewareErrorContext;
  logger?: TelegramMiddlewareErrorLogger;
}): Promise<void> {
  const logger = params.logger ?? console;
  logger.error(
    JSON.stringify({
      event: "telegram_middleware_error",
      updateId: params.context.update.update_id,
      error: sanitizeTelegramError(params.error),
    }),
  );

  if (!isTelegramRepresentativeSessionUnavailableError(params.error)) {
    return;
  }

  try {
    await params.context.reply(
      "当前无法确认你正在使用的数字代表。为避免消息进入错误代表，本次消息未处理，请稍后重试。",
    );
  } catch (replyError) {
    logger.error(
      JSON.stringify({
        event: "telegram_session_error_reply_failed",
        updateId: params.context.update.update_id,
        error: sanitizeTelegramError(replyError),
      }),
    );
  }
}

export function normalizeTelegramCommandEntity(
  message: TelegramMessageLike | undefined,
): boolean {
  const text = message?.text;
  if (!message || typeof text !== "string") {
    return false;
  }
  if (
    message.entities?.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    )
  ) {
    return false;
  }

  const commandToken = text.match(/^\/[a-z0-9_]+(?:@[a-z0-9_]+)?(?=\s|$)/i)?.[0];
  if (!commandToken) {
    return false;
  }

  message.entities = [
    {
      type: "bot_command",
      offset: 0,
      length: commandToken.length,
    },
    ...(message.entities ?? []),
  ];
  return true;
}

export function buildTelegramUpdateMetadata(
  update: TelegramUpdateLike,
  synthesizedCommandEntity = false,
): TelegramUpdateMetadata {
  const message = update.message ?? update.edited_message;
  const command = extractTelegramCommand(message?.text);
  const type = update.message
    ? "message"
    : update.edited_message
      ? "edited_message"
      : update.callback_query
        ? "callback_query"
        : update.pre_checkout_query
          ? "pre_checkout_query"
          : "other";

  return {
    updateId: update.update_id,
    type,
    ...(command ? { command } : {}),
    ...(synthesizedCommandEntity ? { synthesizedCommandEntity: true as const } : {}),
  };
}

export async function logTelegramUpdateExecution(
  metadata: TelegramUpdateMetadata,
  next: () => Promise<unknown>,
  logger: TelegramUpdateLogger = console,
): Promise<void> {
  const startedAt = Date.now();
  logger.info(
    JSON.stringify({
      event: "telegram_update_received",
      ...metadata,
    }),
  );

  try {
    await next();
    logger.info(
      JSON.stringify({
        event: "telegram_update_completed",
        updateId: metadata.updateId,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: "telegram_update_failed",
        updateId: metadata.updateId,
        durationMs: Date.now() - startedAt,
        error: sanitizeTelegramError(error),
      }),
    );
    throw error;
  }
}

export function buildTelegramPollingFailureLog(error: unknown) {
  const errorCode = readTelegramErrorCode(error);
  const reason =
    errorCode === 409
      ? "another_get_updates_consumer"
      : errorCode === 401
        ? "bot_token_rejected"
        : "polling_failed";
  return {
    event: "telegram_polling_stopped",
    reason,
    restartable: errorCode !== 409,
    ...(errorCode ? { errorCode } : {}),
    error: sanitizeTelegramError(error),
  };
}

export function resolveTelegramPollingExitCode(error: unknown): 0 | 1 {
  return readTelegramErrorCode(error) === 409 ? 0 : 1;
}

export function sanitizeTelegramError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown_error";
  return message
    .replace(/bot\d+:[a-z0-9_-]+/gi, "bot[REDACTED]")
    .slice(0, 500);
}

function extractTelegramCommand(text: string | undefined): string | undefined {
  const command = text
    ?.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?=\s|$)/i)?.[1]
    ?.toLowerCase();
  if (!command) {
    return undefined;
  }
  return loggedTelegramCommands.has(command) ? command : "other_command";
}

function readTelegramErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const directCode = Reflect.get(error, "error_code");
  if (typeof directCode === "number") {
    return directCode;
  }
  const nested = Reflect.get(error, "error");
  if (!nested || typeof nested !== "object") {
    return undefined;
  }
  const nestedCode = Reflect.get(nested, "error_code");
  return typeof nestedCode === "number" ? nestedCode : undefined;
}
