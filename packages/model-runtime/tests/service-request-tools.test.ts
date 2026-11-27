import { describe, expect, it, vi } from "vitest";
import { createServiceRequestTools } from "../src/v2/service-request-tools";
import { generateServiceRequestOptions } from "../src/service-request-options";
describe("service request tools", () => {
  it("exposes business operations without SQL, owner identity or owner approval", () => {
    const tools = createServiceRequestTools({ query: vi.fn(), submit: vi.fn() });
    const schema = JSON.stringify(tools.map(tool => tool.parameters));
    expect(schema).not.toMatch(/sql|ownerId|audienceIdentityId|accepted|rejected/);
    expect(tools.map(tool => tool.name)).toEqual(["query_service_requests", "submit_service_requests"]);
    expect(tools.find(tool => tool.name === "query_service_requests")!.effect).toBe("read");
  });
  it("passes host receipts and does not convert rejected submissions into success", async () => {
    const submit = vi.fn().mockResolvedValue({ results: [{ status: "failed", code: "forbidden" }] });
    const tool = createServiceRequestTools({ query: vi.fn(), submit }).find(tool => tool.name === "submit_service_requests")!;
    const result = await tool.execute("call", { overflow: true, items: [] }, new AbortController().signal, {} as never);
    expect(JSON.parse(result.text!)).toEqual({ results: [{ status: "failed", code: "forbidden" }] });
    expect(submit).toHaveBeenCalledWith({ overflow: true, items: [] });
  });
  it("preserves Other fallback for invalid owner questions without a provider call", async () => {
    expect(await generateServiceRequestOptions(" ")).toEqual([{ id: "other", label: "其他" }]);
  });
});
