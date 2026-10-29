import { describe, expect, it, vi } from "vitest";
import { NotionClient } from "../src/notion/client";
import { expandNotionPages, listNotionPages, readNotionPage, notionId, richText } from "../src/notion/content";
import { notionImportSchema } from "../src/notion/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const rt = (text: string) => [{ type: "text", plain_text: text }];
const page = (id = A, properties = {}) => ({ object: "page", id, properties: { title: { type: "title", title: rt("测试页面") }, ...properties } });
const list = (results: unknown[]) => ({ object: "list", results, has_more: false, next_cursor: null });
function fixture(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const transport = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const result = routes[url.pathname + url.search] ?? routes[url.pathname];
    if (result instanceof Response) return result.clone();
    if (result === undefined) throw new Error(`Unexpected request ${url.pathname}`);
    return Response.json(result);
  });
  return { client: new NotionClient("test-token", undefined, transport as typeof fetch), calls, transport };
}
const scope = { workspaceId: "workspace", workspaceName: "Test" };
describe("Notion content selection", () => {
  it("automatically lists authorized database records, deduplicates pages and searches record titles without reading bodies", async () => {
    const record = { ...page(B), properties: { title: { type: "title", title: rt("目标与策略") } } };
    const { client, calls, transport } = fixture({
      "/v1/search": list([page(), record, { object: "data_source", id: C, title: rt("文档") }]),
      [`/v1/data_sources/${C}/query`]: list([record, { ...page(), archived: true }]),
    });
    const entries = await listNotionPages(client);
    expect(entries.map(p => p.id)).toEqual([A, B]);
    expect(entries.every(p => p.kind === "page")).toBe(true);
    expect(await listNotionPages(client, "策略")).toMatchObject([{ id: B, title: "目标与策略" }]);
    expect(calls.every(path => !path.includes("/blocks/") && !path.includes("/pages/"))).toBe(true);
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).not.toHaveProperty("query");
  });
  it("lists records even when search returns only a database", async () => {
    const { client } = fixture({ "/v1/search": list([{ object: "data_source", id: C, title: rt("任务") }]), [`/v1/data_sources/${C}/query`]: list([page(B)]) });
    expect((await listNotionPages(client)).map(p => p.id)).toEqual([B]);
  });
  it("preserves emphasis, deleted text, inline code and links", () => {
    expect(richText([{ plain_text: "旧规则", annotations: { strikethrough: true, bold: true } }])).toBe("**~~旧规则~~**");
    expect(richText([{ plain_text: "a`b", annotations: { code: true }, href: "https://example.com" }])).toBe("[`` a`b ``](https://example.com)");
  });
  it("emits only public source metadata even if the caller supplies a database connection row", async () => {
    const { client } = fixture({ [`/v1/pages/${A}`]: page(), [`/v1/blocks/${A}/children`]: list([]) });
    const row = { ...scope, ownerId: "private-owner", ciphertext: "private-credentials", revision: 1 };
    const doc = await readNotionPage(client, A, row);
    expect(notionImportSchema.safeParse(doc.metadata).success).toBe(true);
    expect(JSON.stringify(doc)).not.toContain("private-");
  });
  it("lists metadata without reading page bodies", async () => {
    const { client, calls } = fixture({ "/v1/search": list([page()]) });
    expect(await listNotionPages(client)).toMatchObject([{ id: A, title: "测试页面" }]);
    expect(calls).toEqual(["/v1/search"]);
  });
  it("keeps child pages, references, databases and attachments without fetching their contents", async () => {
    const { client, calls } = fixture({
      [`/v1/pages/${A}`]: page(),
      [`/v1/blocks/${A}/children`]: list([
        { id: B, type: "child_page", has_children: true, child_page: { title: "子页面" } },
        { id: C, type: "child_database", has_children: true, child_database: { title: "表格" } },
        { id: "link", type: "link_to_page", link_to_page: { page_id: B } },
        { id: "file", type: "pdf", pdf: { file: { url: "http://localhost/private" }, name: "说明.pdf" } },
        { id: "embed", type: "embed", embed: { url: "https://external.example" } },
      ]),
    });
    const doc = await readNotionPage(client, A, scope);
    expect(doc.text).toContain("子页面"); expect(doc.metadata.incomplete).toBe(false);
    expect(doc.metadata.warnings).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });
  it("only expands descendants after an explicit operation, without expanding linked databases", async () => {
    const { client, calls } = fixture({
      [`/v1/pages/${A}`]: page(), [`/v1/pages/${B}`]: page(B),
      [`/v1/blocks/${A}/children`]: list([{ id: B, type: "child_page" }, { id: C, type: "child_database", has_children: true }]),
      [`/v1/blocks/${B}/children`]: list([]),
    });
    expect((await expandNotionPages(client, [A, B])).map(p => p.id)).toEqual([A, B]);
    expect(calls.some(path => path.includes(C))).toBe(false);
  });
  it("reads accessible synced blocks, not the source page, and flags denied blocks as incomplete", async () => {
    const { client, calls } = fixture({
      [`/v1/pages/${A}`]: page(),
      [`/v1/blocks/${A}/children`]: list([
        { id: "sync1", type: "synced_block", synced_block: { synced_from: { block_id: B } } },
        { id: "sync2", type: "synced_block", synced_block: { synced_from: { block_id: C } } },
      ]),
      [`/v1/blocks/${B}/children`]: list([{ type: "paragraph", paragraph: { rich_text: rt("同步正文") } }]),
      [`/v1/blocks/${C}/children`]: new Response("", { status: 404 }),
    });
    const doc = await readNotionPage(client, A, scope);
    expect(doc.text).toContain("同步正文"); expect(doc.metadata.incomplete).toBe(true);
    expect(doc.metadata.warnings.join(" ")).toContain("不可访问");
    expect(calls).not.toContain(`/v1/pages/${B}`);
  });
  it("converts tables, nested text and code, and flags unsupported blocks", async () => {
    const { client } = fixture({
      [`/v1/pages/${A}`]: page(),
      [`/v1/blocks/${A}/children`]: list([
        { id: B, type: "table", has_children: true, table: { table_width: 2, has_column_header: true } },
        { type: "code", code: { language: "javascript", rich_text: rt("const a = 1;") } },
        { type: "future_block" },
      ]),
      [`/v1/blocks/${B}/children`]: list([{ table_row: { cells: [rt("名称"), rt("值")] } }, { table_row: { cells: [rt("a|b"), rt("2")] } }]),
    });
    const doc = await readNotionPage(client, A, scope);
    expect(doc.text).toContain("| 名称 | 值 |\n| --- | --- |");
    expect(doc.text).toContain("a\\|b"); expect(doc.text).toContain("const a = 1;");
    expect(doc.metadata.incomplete).toBe(true);
  });
  it("uses the final rollup aggregate after pagination instead of the initial incomplete value", async () => {
    const path = `/v1/pages/${A}/properties/rollup`;
    const first = { ...list([]), has_more: true, next_cursor: "next", property_item: { rollup: { type: "incomplete" } } };
    const { client } = fixture({
      [`/v1/pages/${A}`]: page(A, { 总量: { type: "rollup", id: "rollup" } }),
      [path]: first, [`${path}?page_size=100`]: first,
      [`${path}?page_size=100&start_cursor=next`]: { ...list([]), property_item: { rollup: { type: "number", number: 123 } } },
      [`/v1/blocks/${A}/children`]: list([]),
    });
    const doc = await readNotionPage(client, A, scope);
    expect(doc.text).toContain("总量: 123"); expect(doc.metadata.incomplete).toBe(false);
  });
  it("does not mark a failed page body as a complete document", async () => {
    const { client } = fixture({ [`/v1/pages/${A}`]: page(), [`/v1/blocks/${A}/children`]: new Response("", { status: 403 }) });
    expect((await readNotionPage(client, A, scope)).metadata.incomplete).toBe(true);
  });
  it("accepts Notion IDs and URLs without requesting arbitrary hosts", () => {
    expect(notionId(`https://www.notion.so/Test-${A.replaceAll("-", "")}?pvs=4`)).toBe(A);
    expect(() => notionId(`https://example.com/${A}`)).toThrow();
  });
});
describe("Notion transport", () => {
  it("retries a transient network reset and respects Notion's Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
        .mockResolvedValueOnce(Response.json(list([page()])));
      const result = new NotionClient("t", undefined, transport).all("/search", {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(transport).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toHaveLength(1);
      expect(transport).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it("paginates search and keeps credentials only on the official API", async () => {
    const transport = vi.fn().mockResolvedValueOnce(Response.json({ ...list([page()]), has_more: true, next_cursor: "next" })).mockResolvedValueOnce(Response.json(list([page(B)])));
    const client = new NotionClient("test-token", undefined, transport);
    expect(await client.all("/search", {})).toHaveLength(2);
    expect(JSON.parse(transport.mock.calls[1]![1].body)).toMatchObject({ start_cursor: "next" });
    expect(transport.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test-token" } });
    await expect(client.request("https://other.example")).rejects.toThrow("Invalid Notion endpoint");
  });
  it("rejects truncated or repeating pagination", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ ...list([]), has_more: true, next_cursor: null }));
    await expect(new NotionClient("t", undefined, transport).all("/search", {})).rejects.toMatchObject({ code: "NETWORK" });
    transport.mockImplementation(async () => Response.json({ ...list([]), has_more: true, next_cursor: "same" }));
    await expect(new NotionClient("t", undefined, transport).all("/search", {})).rejects.toMatchObject({ code: "NETWORK" });
  });
  it("honors cancellation without making any provider request", async () => {
    const transport = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(new NotionClient("t", controller.signal, transport).all("/search", {})).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
