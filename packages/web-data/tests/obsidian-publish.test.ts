import { describe, expect, it, vi } from "vitest";
import { createPublishReader, publishNote, publishUrl, readPublishPage } from "../src/obsidian-publish";
import { lookup } from "node:dns/promises";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { obsidianImportSchema, parseObsidianNote, prepareObsidianNotes } from "../src/knowledge-obsidian";

const id = "1234567890abcdef1234567890abcdef";
const base = "https://publish.obsidian.md/test/";
const host = "publish-01.obsidian.md";
const access = `https://${host}/access/${id}/`;
function shell(path = "A.md", customurl: string | null = null) {
  return `<title>Note - Test - Obsidian Publish</title><script>window.siteInfo=${JSON.stringify({ uid: id, host, slug: "test", customurl })};\nwindow.preloadPage=f(${JSON.stringify(access + path)});</script>`;
}
function fixture(overrides: Record<string, string> = {}) {
  const pages: Record<string, string> = {
    [base]: shell(), [base + "A"]: shell(), [base + "B"]: shell("B.md"),
    [base + "sitemap.xml"]: `<urlset><url><loc>${base}A</loc></url><url><loc>${base}B</loc></url></urlset>`,
    [access + "A.md"]: "# Selected\n\nSee [[B]] and ![[B]].\n\n![image](image.png)",
    ...overrides,
  };
  const read = vi.fn(async (url: string) => {
    if (!(url in pages)) throw new Error(`Unexpected read: ${url}`);
    return { url, text: pages[url]! };
  });
  return { read, reader: createPublishReader(read) };
}
describe("Publish selective import", () => {
  it("lists URLs without fetching any Markdown, cache or attachments", async () => {
    const { reader, read } = fixture();
    const result = await reader.list(base + "A");
    expect(result.notes).toHaveLength(2);
    expect(result.selectedUrl).toBe(base + "A");
    expect(result.incomplete).toBe(false);
    expect(read.mock.calls.map(([url]) => url)).toEqual([base + "A", base + "sitemap.xml"]);
  });
  it("downloads only selected Markdown, without following embedded notes or attachments", async () => {
    const { reader, read } = fixture();
    const result = await reader.download(base, [base + "A", base + "A"]);
    expect(result.files).toHaveLength(1);
    expect(read.mock.calls.map(([url]) => url)).toEqual([base, base + "A", access + "A.md"]);
    const parsed = parseObsidianNote(`publish-${id}/A.md`, result.files[0]!.text);
    const prepared = prepareObsidianNotes([parsed], [`publish-${id}/A.md`, `publish-${id}/B.md`]);
    expect(prepared[0]!.requestedPaths).toEqual([`publish-${id}/B.md`]);
    expect(prepared[0]!.text).toContain("引用未导入");
  });
  it("keeps the given note available when the sitemap is unavailable", async () => {
    const { reader } = fixture({ [base + "sitemap.xml"]: "<html>Not found</html>" });
    const result = await reader.list(base + "A");
    expect(result.incomplete).toBe(true);
    expect(result.notes).toEqual([{ path: "A.md", url: base + "A" }]);
  });
  it("does not preselect a home page for a site URL", async () => {
    expect((await fixture().reader.list(base)).selectedUrl).toBeNull();
  });
  it("resolves a permalink to the original Markdown path only after selection", async () => {
    const { reader } = fixture({ [base + "A"]: shell("Folder/Original.md"), [access + "Folder/Original.md"]: "# Actual note\n\nActual original content." });
    expect((await reader.download(base, [base + "A"])).files[0]!.path).toBe("Folder/Original.md");
  });
  it("supports Publish on a custom domain with a path prefix", async () => {
    const root = "https://notes.example.com/help/";
    const { reader } = fixture({ [root]: shell("A.md", "notes.example.com/help"), [root + "sitemap.xml"]: `<urlset><url><loc>${root}A</loc></url></urlset>` });
    expect((await reader.list(root)).site.url).toBe(root);
  });
  it("rejects other-site selections and empty selections", async () => {
    await expect(fixture().reader.download(base, ["https://elsewhere.example/A"])).rejects.toThrow("当前站点");
    await expect(fixture().reader.download(base, [])).rejects.toThrow("请选择");
  });
  it("rejects shells and missing access information instead of importing a title", async () => {
    await expect(fixture({ [access + "A.md"]: "<!doctype html><html>Login</html>" }).reader.download(base, [base + "A"])).rejects.toThrow("正文");
    await expect(fixture({ [base + "A"]: shell().replace(/window.preloadPage.*?<\/script>/, "</script>") }).reader.download(base, [base + "A"])).rejects.toThrow("密码保护");
  });
  it("rejects forged access hosts and non-Publish pages", async () => {
    await expect(fixture({ [base + "A"]: shell().replace(access, "https://internal.example/access/") }).reader.download(base, [base + "A"])).rejects.toThrow("来源不匹配");
    await expect(fixture({ [base]: "<html>Not Publish</html>" }).reader.list(base)).rejects.toThrow("未识别");
  });
  it.each(["http://example.com", "https://127.0.0.1", "https://localhost", "https://user:pass@example.com", "https://example.com:444/"])("rejects unsafe URL %s", url => {
    expect(() => publishUrl(url)).toThrow();
  });
  it("does not interpret attachments as notes", () => {
    expect(() => publishNote(base + "image.png", { id, host, url: base, name: "Test" })).toThrow("附件");
  });
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.0.1"])("rejects a domain resolving to %s before making a connection", async address => {
    vi.mocked(lookup).mockResolvedValue([{ address, family: 4 }] as never);
    await expect(readPublishPage("https://notes.example.com/")).rejects.toThrow("公网地址");
  });
  it("validates and retains descriptive Publish provenance", () => {
    const provenance = { siteName: "Test", sourceUrl: base + "A", originalPath: "A.md", importedAt: new Date().toISOString() };
    expect(obsidianImportSchema.parse({ sourcePath: "root/A.md", properties: {}, referencedPaths: [], warnings: [], publishSource: provenance }).publishSource).toEqual(provenance);
    expect(() => obsidianImportSchema.parse({ sourcePath: "root/A.md", properties: {}, referencedPaths: [], warnings: [], publishSource: { ...provenance, sourceUrl: "javascript:alert(1)" } })).toThrow();
  });
});
