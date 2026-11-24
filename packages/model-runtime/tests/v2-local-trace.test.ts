import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { withLocalTrace } from "@delegate/runtime/local-trace";
import { DelegateAgentV2, type V2RunInput } from "../src/v2";
let directory: string;
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });
function setup() {
 directory = mkdtempSync(join(tmpdir(), "v2-trace-")); vi.stubEnv("DELEGATE_LOCAL_TRACE_ENABLED", "1"); vi.stubEnv("DELEGATE_LOCAL_TRACE_DIR", directory);
 const faux = fauxProvider({ tokensPerSecond: 1000000 });
 const models = createModels(); models.setProvider(faux.provider);
 const input: V2RunInput = { requestId: "trace-run", sessionId: "trace-session", scope: "trace-scope", userText: "QUESTION", timezone: "UTC", context: { traceId: "trace-run", runId: "trace-run", sessionId: "trace-session", timezone: "UTC", attachments: [], idempotencyKey: "trace-run" }, model: { provider: "faux", modelId: "test", model: faux.getModel(), streamFn: models.streamSimple.bind(models) }, authorize: async () => {}, tools: [], citationSourceNumber: async () => "1" };
 return { faux, input };
}
function rows() { return readFileSync(join(directory, readdirSync(directory)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line)); }
it("records actual model contexts, concurrent calls, raw and normalized tool results, recovery and final output", async () => {
 const { faux, input } = setup();
 faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", { query: "A" }), fauxToolCall("lookup", { query: "B" })], { stopReason: "toolUse" }), fauxAssistantMessage('<reference source="9">WRONG</reference>'), fauxAssistantMessage('<reference source="1">FIXED</reference>')]);
 input.tools = [{ name: "lookup", label: "lookup", description: "read", category: "knowledge", effect: "read", parameters: Type.Object({ query: Type.String() }), execute: async (_id, args) => ({ text: "BODY_" + args.query, sources: [{ id: "source", title: "Title", channel: "knowledge" }] }) }];
 const result = await withLocalTrace("worker", { runId: input.requestId }, () => new DelegateAgentV2().run(input));
 expect(result.citationStatus).toBe("valid");
 const records = rows(); const inputs = records.filter(row => row.event === "model.input");
 expect(inputs).toHaveLength(3); expect(JSON.stringify(inputs[0].data.context)).toContain("QUESTION");
 expect(JSON.stringify(inputs[2].data.context)).toContain("WRONG"); expect(inputs[2].data.context.tools).toEqual([]);
 expect(records.filter(row => row.event === "tool.raw_result")).toHaveLength(2);
 expect(records.filter(row => row.event === "tool.normalized_result")).toHaveLength(2);
 expect(records.filter(row => row.event === "agent.message_end" && row.data.message.role === "assistant")).toHaveLength(3);
 expect(records.find(row => row.event === "runtime.final").data).toMatchObject({ text: "FIXED", citationDiagnostics: { recoveryCount: 1 } });
 expect(records.at(-1).event).toBe("lifecycle.completed");
});
it("retains the original authorization error and the runtime failure even when turned into permission_denied", async () => {
 const { input } = setup(); input.authorize = async () => { throw Object.assign(new Error("synthetic DB conflict"), { code: "P2034" }); };
 const result = await withLocalTrace("worker", {}, () => new DelegateAgentV2().run(input));
 expect(result.error).toBe("permission_denied");
 expect(rows().find(row => row.event === "authorization.failed").data.error.code).toBe("P2034");
 expect(rows().some(row => row.event === "runtime.failed")).toBe(true);
});
