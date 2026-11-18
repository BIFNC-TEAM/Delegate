import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), generate: vi.fn() }));
vi.mock("../app/api/dashboard/auth", () => ({ requireDashboardApiOwnerSession: mocks.session, dashboardAuthErrorResponse: () => null }));
vi.mock("@delegate/model-runtime", async original => ({ ...await original<typeof import("@delegate/model-runtime")>(), generateServiceContentSuggestion: mocks.generate }));
import { POST } from "../app/api/dashboard/service-content-suggestions/route";
const request = (body: unknown) => new Request("http://localhost/api/dashboard/service-content-suggestions", { method:"POST",body:JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue({ownerId:"test-owner"}); mocks.generate.mockResolvedValue({status:"success",serviceContent:"建议",truncated:false,attempts:[{provider:"secret"}]}); });
it("requires login even in demo mode", async () => { mocks.session.mockResolvedValue(null); expect((await POST(request({}))).status).toBe(401); expect(mocks.generate).not.toHaveBeenCalled(); });
it.each([{workFields:1},{serviceContent:1},{language:"fr"},{workFields:Array.from({length:21},(_,i)=>String(i))},{workFields:["😀".repeat(81)]},{serviceContent:"😀".repeat(501)}])("rejects invalid input %j", async input => {expect((await POST(request(input))).status).toBe(400); expect(mocks.generate).not.toHaveBeenCalled();});
it("normalizes and defaults", async () => { const response=await POST(request({workFields:[" 销售 ","销售",""]})); expect(mocks.generate).toHaveBeenCalledWith({workFields:["销售"],serviceContent:"",language:"zh"}); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.json()).not.toHaveProperty("attempts"); });
it.each([["empty_suggestion",200],["insufficient_input",200],["timeout",504],["model_failure",502]])("maps %s", async (status,http) => {mocks.generate.mockResolvedValue({status,serviceContent:"",truncated:false,attempts:[]}); expect((await POST(request({}))).status).toBe(http);});
it("hides unexpected exceptions", async () => { mocks.generate.mockRejectedValue(new Error("private input")); const response=await POST(request({serviceContent:"原文"})); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("private input"); });


it("limits streamed bytes without trusting content length", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(131072)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    const req = new Request("http://localhost/test", { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
    const response = await POST(req);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(cancelled).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled();
  }
});
it("accepts a body at the byte limit and rejects one byte over", async () => {
  // Use JSON whitespace rather than an unknown field, retaining valid input.
  const base = JSON.stringify({ workFields: ["销售", "销售"] });
  const padding = 131072 - new TextEncoder().encode(base).length;
  const exact = base + " ".repeat(padding);
  expect((await POST(new Request("http://localhost/test", { method: "POST", body: exact }))).status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith({ workFields: ["销售"], serviceContent: "", language: "zh" });
  mocks.generate.mockClear();
  expect((await POST(new Request("http://localhost/test", { method: "POST", body: exact + " " }))).status).toBe(413);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("authenticates before reading a large body", async () => {
  mocks.session.mockResolvedValue(null);
  let read = false;
  const stream = new ReadableStream({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
  const req = new Request("http://localhost/test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect((await POST(req)).status).toBe(401);
  expect(read).toBe(false);
});
it("rejects an oversized declared length before reading", async () => {
  const req = new Request("http://localhost/test", { method: "POST", body: "{}", headers: { "content-length": "131073" } });
  expect((await POST(req)).status).toBe(413);
  expect(mocks.generate).not.toHaveBeenCalled();
});

it("returns 400 when reading the request body fails", async () => {
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error("read failure")); } });
  const req = new Request("http://localhost/test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect((await POST(req)).status).toBe(400);
  expect(mocks.generate).not.toHaveBeenCalled();
});
