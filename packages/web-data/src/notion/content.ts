import { NotionClient, type NotionObject } from "./client";
import { NotionError, type NotionEntry, type NotionDocument } from "./types";

export function notionId(value: string): string {
  let text = value;
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)notion\.(so|site|com)$/.test(url.hostname)) throw new NotionError("ACCESS", "请输入 Notion 页面链接。 / Enter a Notion page URL.");
    text = url.pathname;
  }
  const match = text.match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:$|[/?])/i);
  if (!match) throw new NotionError("ACCESS", "Notion 页面 ID 无效。 / Invalid page ID.");
  const raw = match[1]!.replaceAll("-", "").toLowerCase();
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
const canonicalUrl = (id: string) => `https://www.notion.so/${id.replaceAll("-", "")}`;
export function richText(parts: NotionObject[] = []): string {
  return parts.map(part => {
    if (part.type === "equation") return `$${part.equation?.expression ?? ""}$`;
    if (part.type === "mention" && part.mention?.type === "date") return [part.mention.date?.start, part.mention.date?.end].filter(Boolean).join(" – ");
    let value = String(part.plain_text ?? part.text?.content ?? "");
    const annotations = part.annotations ?? {};
    if (annotations.code && value) {
      const fence = "`".repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length)) + 1);
      value = `${fence} ${value} ${fence}`;
    }
    if (annotations.strikethrough) value = `~~${value}~~`;
    if (annotations.bold) value = `**${value}**`;
    if (annotations.italic) value = `*${value}*`;
    if (annotations.underline) value = `<u>${value}</u>`;
    const link = part.href ?? part.text?.link?.url;
    if (link && /^https?:\/\//i.test(link)) return `[${value || "引用 / Reference"}](${String(link).replace(/\)/g, "%29")})`;
    return value;
  }).join("");
}
export function entryOf(page: NotionObject): NotionEntry {
  const titleParts = page.object === "data_source" ? page.title : (Object.values(page.properties ?? {}) as NotionObject[]).find(p => p.type === "title")?.title;
  const title = (titleParts ?? []).map((part: NotionObject) => part.plain_text ?? part.text?.content ?? "").join("");
  const parent = page.parent ?? {};
  return { id: page.id, title: title || "无标题 / Untitled", url: canonicalUrl(page.id), kind: page.object === "data_source" ? "data_source" : "page", parentId: parent.page_id ?? parent.data_source_id ?? parent.database_id ?? null };
}
export async function listNotionPages(client: NotionClient, query = "") {
  // Search indexes database titles separately from their records. Discover all
  // authorized sources first so a note-title search cannot hide its database.
  const results = await client.all("/search", { sort: { direction: "descending", timestamp: "last_edited_time" } });
  const available = results.filter(p => !p.in_trash && !p.archived);
  const pages = new Map<string, NotionEntry>(available.filter(p => p.object === "page").map(p => [p.id, entryOf(p)]));
  const sources = new Set(available.filter(p => p.object === "data_source").map(p => p.id));
  // Sequential requests keep automatic enumeration within provider rate limits.
  // Only record metadata is queried; block bodies remain an explicit read action.
  for (const sourceId of sources) {
    for (const record of await listNotionRecords(client, sourceId)) pages.set(record.id, record);
  }
  const term = query.trim().toLowerCase();
  return [...pages.values()].filter(page => !term || page.title.toLowerCase().includes(term));
}
export async function listNotionRecords(client: NotionClient, sourceId: string) {
  return (await client.all(`/data_sources/${notionId(sourceId)}/query`, {})).filter(p => !p.in_trash && !p.archived).map(entryOf);
}
export async function lookupNotionPage(client: NotionClient, value: string) {
  return entryOf(await client.request(`/pages/${notionId(value)}`));
}
// This is an explicit operation after the user requests descendant inclusion.
// Databases/views are not traversed, so a linked view never expands to a full database.
export async function expandNotionPages(client: NotionClient, selected: string[]) {
  const found = new Map<string, NotionEntry>();
  async function visit(id: string, depth: number) {
    id = notionId(id); if (found.has(id)) return;
    if (depth > 12 || found.size >= 1000) throw new NotionError("LIMIT", "子页面过多或层级过深，请分批选择。 / Too many descendants.");
    found.set(id, await lookupNotionPage(client, id));
    async function children(blockId: string, level: number): Promise<void> {
      if (level > 20) throw new NotionError("LIMIT", "内容层级过深。 / Content nesting limit reached.");
      for (const block of await client.all(`/blocks/${blockId}/children`)) {
        if (block.type === "child_page") await visit(block.id, depth + 1);
        else if (block.has_children && !["child_database", "synced_block", "link_to_page"].includes(block.type)) await children(block.id, level + 1);
      }
    }
    await children(id, 0);
  }
  for (const id of selected) await visit(id, 0);
  return [...found.values()];
}

export async function readNotionPage(client: NotionClient, id: string, workspace: { workspaceId: string; workspaceName: string }): Promise<NotionDocument> {
  id = notionId(id);
  const page = await client.request(`/pages/${id}`); const entry = entryOf(page);
  const warnings = new Set<string>(); let incomplete = false; let count = 0;
  const missing = (message: string) => { incomplete = true; warnings.add(message); return `[${message}]`; };
  const cache = new Map<string, string>();
  async function children(blockId: string, stack: string[] = []): Promise<string> {
    if (stack.includes(blockId) || stack.length >= 20) return missing("循环或过深的嵌入内容未展开 / Cyclic or deeply nested content omitted");
    if (cache.has(blockId)) return cache.get(blockId)!;
    let blocks: NotionObject[];
    try { blocks = await client.all(`/blocks/${blockId}/children`); }
    catch (error) {
      if (error instanceof NotionError && error.code === "ACCESS") return missing(`部分内容不可访问，请补充来源权限 / Content unavailable: ${canonicalUrl(blockId)}`);
      throw error;
    }
    const result: string[] = []; let renderedLength = 0;
    for (const block of blocks) {
      if (++count > 4000) throw new NotionError("LIMIT", "页面内容过多，请拆分后导入。 / Page too large.");
      const type = block.type; const data = block[type] ?? {}; const text = richText(data.rich_text);
      let value = "";
      switch (type) {
        case "paragraph": value = text; break;
        case "heading_1": case "heading_2": case "heading_3": case "heading_4": value = `${"#".repeat(Number(type.slice(-1)))} ${text}`; break;
        case "bulleted_list_item": value = `- ${text}`; break;
        case "numbered_list_item": value = `1. ${text}`; break;
        case "to_do": value = `- [${data.checked ? "x" : " "}] ${text}`; break;
        case "quote": case "callout": value = `> ${text}`; break;
        case "toggle": value = `#### ${text}`; break;
        case "code": value = `\`\`\`\`${data.language ?? ""}\n${text}\n\`\`\`\``; break;
        case "equation": value = `$$\n${data.expression ?? ""}\n$$`; break;
        case "divider": value = "---"; break;
        case "table": {
          const rows = await client.all(`/blocks/${block.id}/children`);
          const cells = rows.map(row => (row.table_row?.cells ?? []).map((cell: NotionObject[]) => richText(cell).replaceAll("|", "\\|").replaceAll("\n", "<br>")));
          if (cells.length) {
            if (!data.has_column_header) cells.unshift(Array.from({ length: data.table_width }, () => ""));
            cells.splice(1, 0, Array.from({ length: data.table_width }, () => "---"));
            value = cells.map(row => `| ${row.join(" | ")} |`).join("\n");
          }
          break;
        }
        case "synced_block": value = await children(data.synced_from?.block_id ?? block.id, [...stack, blockId]); break;
        case "child_page": value = `[${data.title || "子页面 / Child page"}](${canonicalUrl(block.id)})`; break;
        case "child_database": value = `[${data.title || "数据库 / Database"}](${canonicalUrl(block.id)})`; warnings.add("数据库视图未展开，请单独选择记录 / Database records are not included automatically"); break;
        case "link_to_page": value = `[引用页面 / Linked page](${canonicalUrl(data.page_id ?? data.database_id ?? block.id)})`; break;
        case "image": case "pdf": case "file": case "audio": case "video":
          value = `[附件内容未导入 / Attachment not imported: ${data.name ?? richText(data.caption) ?? type}]`;
          warnings.add("附件正文未导入 / Attachment contents excluded"); break;
        case "bookmark": case "embed": case "link_preview":
          value = /^https?:\/\//i.test(data.url ?? "") ? `[${richText(data.caption) || "外部内容 / External content"}](${String(data.url).replace(/\)/g, "%29")})` : "";
          warnings.add("外部嵌入仅保留链接 / External content retained as links only"); break;
        case "column_list": case "column": case "table_of_contents": case "breadcrumb": break;
        default: value = missing(`未读取的内容类型 / Unsupported content: ${String(type).slice(0, 80)}`);
      }
      if (block.has_children && !["table", "synced_block", "child_page", "child_database", "link_to_page"].includes(type)) value += `\n\n${await children(block.id, [...stack, blockId])}`;
      result.push(value);
      renderedLength += value.length + 2;
      if (renderedLength > 400_000) throw new NotionError("LIMIT", "页面正文超过 400,000 字符。 / Page too large.");
    }
    const rendered = result.filter(Boolean).join("\n\n"); cache.set(blockId, rendered); return rendered;
  }
  const fields: string[] = [];
  for (const [name, property] of Object.entries(page.properties ?? {}) as [string, NotionObject][]) {
    if (property.type === "title") continue;
    let value: unknown = property[property.type];
    // Retrieve the complete property rather than silently accepting the page's 25-item projection.
    if (["relation", "people", "rich_text", "rollup", "formula"].includes(property.type)) {
      try {
        const path = `/pages/${id}/properties/${encodeURIComponent(decodeURIComponent(property.id))}`;
        const full = await client.request(path);
        if (full.object === "list") {
          const collection = full.has_more ? await client.collection(path) : { items: full.results, last: full };
          const items = collection.items;
          value = items.map((item: NotionObject) => item[property.type]);
          if (property.type === "rollup") value = collection.last.property_item?.rollup ?? { type: "incomplete" };
        } else value = full[property.type];
      } catch (error) {
        if (!(error instanceof NotionError) || error.code !== "ACCESS") throw error;
        fields.push(`${name}: ${missing("字段不可访问 / Property unavailable")}`); continue;
      }
    }
    switch (property.type) {
      case "rich_text": value = richText(value as NotionObject[]); break;
      case "relation":
        value = (value as NotionObject[]).map(v => canonicalUrl(v.id)).join(", ");
        warnings.add("关联目标未展开；权限不足可能影响字段完整性 / Relations are not expanded; permissions may affect completeness"); break;
      case "people": value = (value as NotionObject[]).map(v => v.name ?? "用户 / User").join(", "); break;
      case "select": case "status": value = (value as NotionObject)?.name; break;
      case "multi_select": value = (value as NotionObject[]).map(v => v.name).join(", "); break;
      case "date": value = [(value as NotionObject)?.start, (value as NotionObject)?.end].filter(Boolean).join(" – "); break;
      case "files": value = "附件内容未导入 / Attachments excluded"; warnings.add(String(value)); break;
      case "formula": case "rollup": {
        const computed = value as NotionObject;
        if (!computed || ["incomplete", "unsupported"].includes(computed.type)) value = missing("计算结果不完整 / Calculation incomplete");
        else value = computed[computed.type] ?? computed;
        warnings.add("计算结果为 Notion 返回的快照，未独立校验关联来源 / Calculation snapshot supplied by Notion"); break;
      }
    }
    fields.push(`${name}: ${value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  const text = [`# ${entry.title}`, fields.length ? `## 页面属性 / Properties\n\n${fields.join("\n\n")}` : "", await children(id)].filter(Boolean).join("\n\n");
  if (text.length > 400_000) throw new NotionError("LIMIT", "页面正文超过 400,000 字符。 / Page too large.");
  return { id, title: entry.title, text, metadata: { workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName, pageId: id, sourceUrl: entry.url, importedAt: new Date().toISOString(), incomplete, warnings: [...warnings].slice(0, 100) } };
}
