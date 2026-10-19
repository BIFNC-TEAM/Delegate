import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stableSha256 } from "@delegate/runtime";
import type { McpRecoveryContract } from "@delegate/compute-protocol";

export const submitSchema = { type: "object", properties: { amount: { type: "number" }, request_key: { type: "string" } }, required: ["amount"], additionalProperties: false };
export const statusSchema = { type: "object", properties: { query_key: { type: "string" } }, required: ["query_key"], additionalProperties: false };
export const schemaHash = (inputSchema: unknown) => stableSha256({ inputSchema, outputSchema: null }).replace(/^sha256:/u, "");
export function fixtureRecoveryContract(kind: "argument" | "header" = "argument"): McpRecoveryContract {
  return { version: 1, id: `synthetic.atomic-submit.${kind}.v1`, mode: "keyed", scope: "endpoint_tool", retentionSeconds: 60,
    key: kind === "argument" ? { kind, name: "request_key" } : { kind, name: "idempotency-key" },
    receipt: { keyField: "request_key", stateField: "state", succeeded: ["succeeded"], failedNoEffect: ["failed_no_effect"], pending: ["pending"], notFound: ["not_found"] },
    query: { toolName: "status", toolSchemaHash: schemaHash(statusSchema), keyArgument: "query_key", readOnly: true }, cancellation: "unsupported", conditionalSubmission: "unsupported" };
}
export async function startRecoveryFixture() {
  const calls: Array<{ method: string; name?: string; arguments?: Record<string, any>; header?: string }> = [];
  const effects = new Map<string, string>();
  const controls = { dropSubmissions: 0, dropReads: 0, status: "succeeded", wrongStatusKey: false, onSubmit: undefined as (() => void | Promise<void>) | undefined, onQuery: undefined as (() => void | Promise<void>) | undefined };
  let unkeyed = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()); const method = message.method; const args = message.params?.arguments ?? {};
    const header = request.headers["idempotency-key"] as string | undefined;
    calls.push({ method, ...(message.params?.name ? { name: message.params.name, arguments: structuredClone(args) } : {}), ...(header ? { header } : {}) });
    const reply = (result: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (method === "initialize") { reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-recovery", version: "1" } }); return; }
    if (method === "notifications/initialized") { response.writeHead(202).end(); return; }
    if (method === "tools/list") { reply({ tools: [{ name: "submit", inputSchema: submitSchema }, { name: "status", inputSchema: statusSchema }, { name: "read", inputSchema: submitSchema }] }); return; }
    if (method === "tools/call" && message.params.name === "submit") {
      const key = header ?? args.request_key ?? `unkeyed-${++unkeyed}`;
      const business = JSON.stringify({ amount: args.amount }); const original = effects.get(key);
      if (original && original !== business) { reply({ isError: true, content: [{ type: "text", text: "synthetic_key_payload_conflict" }] }); return; }
      if (!["pending", "failed_no_effect"].includes(controls.status)) effects.set(key, business);
      await controls.onSubmit?.();
      if (controls.dropSubmissions-- > 0) { response.destroy(); return; }
      const structuredContent = { request_key: key, state: ["pending", "failed_no_effect"].includes(controls.status) ? controls.status : "succeeded" }; reply({ structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] }); return;
    }
    if (method === "tools/call" && message.params.name === "status") {
      await controls.onQuery?.();
      const structuredContent = { request_key: controls.wrongStatusKey ? "wrong-operation" : args.query_key, state: controls.status,
        privateDebug: "SYNTHETIC_PROVIDER_PRIVATE_DEBUG" }; // transport must minimize observations
      reply({ structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] }); return;
    }
    if (method === "tools/call" && message.params.name === "read") {
      if (controls.dropReads-- > 0) { response.destroy(); return; }
      reply({ content: [{ type: "text", text: "Synthetic public read" }] }); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, effects, controls,
    close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}
