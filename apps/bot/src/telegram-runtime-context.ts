import { AsyncLocalStorage } from "node:async_hooks";

export type TelegramRuntimeContext = {
  internalConnectionId: string;
  botId: string;
  username?: string;
};

const telegramRuntimeStorage =
  new AsyncLocalStorage<TelegramRuntimeContext>();

export function runWithTelegramRuntimeContext<T>(
  context: TelegramRuntimeContext,
  callback: () => T,
): T {
  return telegramRuntimeStorage.run(context, callback);
}

export function getTelegramRuntimeContext():
  | TelegramRuntimeContext
  | undefined {
  return telegramRuntimeStorage.getStore();
}

export function requireTelegramRuntimeContext(): TelegramRuntimeContext {
  const context = getTelegramRuntimeContext();
  if (!context) {
    throw new Error(
      "Telegram runtime context is unavailable outside an active Bot connection.",
    );
  }
  return context;
}
