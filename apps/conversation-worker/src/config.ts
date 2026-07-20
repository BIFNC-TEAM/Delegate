import { z } from "zod";

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pollMs: z.number().int().min(100).max(60_000),
  matrixHomeserverUrl: z.string().url().optional(),
  matrixApplicationServiceToken: z.string().min(24).optional(),
  telegramBotToken: z.string().min(20).optional(),
});

export type ConversationWorkerConfig = z.infer<typeof configSchema>;

export function resolveConversationWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): ConversationWorkerConfig {
  const matrixHomeserverUrl = env.MATRIX_HOMESERVER_URL?.trim() || undefined;
  const matrixApplicationServiceToken = env.MATRIX_AS_TOKEN?.trim() || undefined;
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  if (Boolean(matrixHomeserverUrl) !== Boolean(matrixApplicationServiceToken)) {
    throw new Error("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN must be configured together.");
  }

  return configSchema.parse({
    port: Number(env.CONVERSATION_WORKER_PORT || 4040),
    pollMs: Number(env.CONVERSATION_WORKER_POLL_MS || 500),
    ...(matrixHomeserverUrl ? { matrixHomeserverUrl } : {}),
    ...(matrixApplicationServiceToken ? { matrixApplicationServiceToken } : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
  });
}
