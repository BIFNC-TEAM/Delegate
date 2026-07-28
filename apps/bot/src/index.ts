import "dotenv/config";

import { startTelegramBotSupervisor } from "./telegram-supervisor";

const supervisor = await startTelegramBotSupervisor();

let stopping = false;
async function stop(signal: "SIGINT" | "SIGTERM") {
  if (stopping) return;
  stopping = true;
  await supervisor.stop(signal);
}

process.once("SIGINT", () => {
  void stop("SIGINT");
});
process.once("SIGTERM", () => {
  void stop("SIGTERM");
});
