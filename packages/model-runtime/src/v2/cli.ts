import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createPiModelBindingFromEnv } from "../pi/provider";
import { createV2Capabilities } from "./capabilities";
import { resolveV2Budget } from "./config";
import { delegateAgentV2 } from "./runtime";
import { v2FixtureAdapters } from "./fixtures";
import type { V2Session } from "./types";

const args = process.argv.slice(2);
const sessionFlag = args.indexOf("--session");
const sessionPath = sessionFlag >= 0 ? resolve(args.splice(sessionFlag, 2)[1]!) : undefined;
const fixtures = args.includes("--fixture-tools");
const userText = args.filter(s => s !== "--fixture-tools" && s !== "--").join(" ");
if (!userText) throw new Error('Usage: pnpm agent:v2 [--fixture-tools] [--session .local/v2.json] "question"');
const budget = resolveV2Budget();
const binding = createPiModelBindingFromEnv({ ...process.env, DELEGATE_PI_MODEL_MAX_RETRIES: "0", DELEGATE_PI_MAX_OUTPUT_TOKENS: String(budget.outputTokens) });
if (!binding.ok) throw new Error(binding.reason);
let session: V2Session | undefined;
if (sessionPath) {
  const saved = await readFile(sessionPath, "utf8").catch(error => { if (error.code === "ENOENT") return "null"; throw error; });
  const data = JSON.parse(saved);
  if (data?.version === 1 && data?.status === "waiting_user") session = data;
}
const requestId = randomUUID();
const context = { runId: requestId, traceId: requestId, sessionId: sessionPath ?? requestId, timezone: process.env.DELEGATE_V2_TIMEZONE ?? "Asia/Shanghai", attachments: [], idempotencyKey: requestId };
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
if (fixtures) process.stderr.write("Synthetic fixture tools enabled. Returned business/weather facts are test data.\n");
const tools = await createV2Capabilities(fixtures ? v2FixtureAdapters() : {}, context, controller.signal);
const persist = async (state: V2Session | null) => {
  if (!sessionPath) return;
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
  await writeFile(sessionPath, JSON.stringify(state), { mode: 0o600 });
};
const result = await delegateAgentV2.run({ requestId, sessionId: context.sessionId, scope: "local-developer-fixture-v1", userText, timezone: context.timezone,
  context, model: binding.binding, tools, budget, ...(session ? { session } : {}), signal: controller.signal,
  authorize: async () => undefined, saveSession: persist,
  onEvent: event => { if (event.type === "tool.started" || event.type === "tool.completed") process.stderr.write(`${event.type}: ${event.toolName}\n`); },
});
await persist(result.session ?? null);
process.removeListener("SIGINT", cancel);
const { sourceBindings: _bindings, session: _session, ...publicResult } = result;
process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
if (result.status === "failed") process.exitCode = 1;
