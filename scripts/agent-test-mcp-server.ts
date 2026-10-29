import { createServer } from "node:http";

const port = Number(process.env.AGENT_TEST_MCP_PORT ?? 4050);
const orders = [
  ["O1001", "2026-09-01", "深圳", "completed", 2, 100, 0],
  ["O1002", "2026-09-01", "广州", "completed", 1, 200, 0],
  ["O1003", "2026-09-02", "深圳", "completed", 3, 100, 50],
  ["O1004", "2026-09-02", "上海", "cancelled", 2, 150, 0],
  ["O1005", "2026-09-03", "深圳", "completed", 1, 300, 0],
  ["O1006", "2026-09-03", "广州", "refunded", 1, 200, 200],
  ["O1007", "2026-09-04", "上海", "completed", 2, 150, 0],
  ["O1008", "2026-09-04", "深圳", "completed", 1, 100, 0],
].map(([order_id, date, city, status, quantity, unit_price, refund_amount]) => ({
  order_id, date, city, status, quantity, unit_price, refund_amount,
}));
const tickets = new Map<string, string>();

const tools = [
  {
    name: "list_orders",
    description: "List all isolated test orders for an inclusive local date range.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_order",
    description: "Get one isolated test order by order_id.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ticket",
    description: "Create an idempotent ticket for an isolated test order.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        issue: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["order_id", "issue"],
      additionalProperties: false,
    },
  },
];

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "agent-test-mcp" }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  const body = await readBody(request);
  const message = JSON.parse(body) as {
    jsonrpc: "2.0";
    id?: string | number;
    method: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (typeof message.id === "undefined") {
    response.writeHead(202).end();
    return;
  }
  let result: unknown;
  if (message.method === "initialize") {
    result = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "delegate-agent-regression", version: "1.0.0" },
    };
  } else if (message.method === "tools/list") {
    result = { tools };
  } else if (message.method === "tools/call") {
    result = callTool(message.params?.name ?? "", message.params?.arguments ?? {});
  } else {
    sendJson(response, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
    return;
  }
  sendJson(response, { jsonrpc: "2.0", id: message.id, result });
}).listen(port, "0.0.0.0", () => {
  process.stdout.write(`Agent test MCP listening on ${port}\n`);
});

function callTool(name: string, args: Record<string, unknown>) {
  if (name === "list_orders") {
    const start = String(args.start_date ?? "");
    const end = String(args.end_date ?? "");
    return toolContent({
      status: "completed",
      rows: orders.filter((order) => String(order.date) >= start && String(order.date) <= end),
      total: orders.length,
      data_time: "2026-09-08T09:00:00+08:00",
      provider: "delegate-agent-test-orders",
    });
  }
  if (name === "get_order") {
    const order = orders.find((item) => item.order_id === args.order_id);
    return toolContent(order
      ? { status: "found", order, provider: "delegate-agent-test-orders" }
      : { status: "not_found", order_id: args.order_id, provider: "delegate-agent-test-orders" });
  }
  if (name === "create_ticket") {
    const key = String(args.idempotency_key ?? `${args.order_id}:${args.issue}`);
    const ticketId = tickets.get(key) ?? `T-${tickets.size + 1}`;
    tickets.set(key, ticketId);
    return toolContent({ status: "created", ticket_id: ticketId, provider: "delegate-agent-test-tickets" });
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "not_found", tool: name }) }] };
}

function toolContent(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function sendJson(response: import("node:http").ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
