// Run only against an isolated, no-database Dashboard in demo mode.
// OBSIDIAN_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.OBSIDIAN_PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.OBSIDIAN_TEST_URL || "http://127.0.0.1:3311";
if (!["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname)) throw new Error("Use an isolated local demo Dashboard.");
const output = await mkdtemp(join(tmpdir(), "delegate-obsidian-"));
const runId = Date.now();
const vault = join(output, `测试笔记库-${runId}`);
const title = `说明-${runId}`;
const filename = `${title}.md`;
const source = "---\ntitle: 产品说明\naliases: [产品介绍]\n内部成本: 99173\n---\n# 产品说明\n我们销售电脑整机及配件，测试范围覆盖中国大陆。\n![[共享规则#售后]]\n![[图片.png]]";
const fixtures = {
  [`产品A/${filename}`]: source,
  [`产品B/${filename}`]: "# 产品B\n这是产品B的电脑配件说明，仅供本地自动化导入验证，不涉及真实业务数据。",
  "共享规则.md": "# 售后\n测试售后标记：保修期限三年，订单可在七日内联系人工处理。\n# 内部\n不应嵌入产品的额外段落。",
  "私人/日记.md": "PRIVATE_UNSELECTED_NOTE_CONTENT，绝对不应被上传。",
  ".obsidian/config.md": "EXCLUDED_SETTINGS",
  "图片.png": "not-an-image",
};
for (const [path, body] of Object.entries(fixtures)) { const file = join(vault, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, body); }
const browser = await chromium.launch({ headless: true, ...(process.env.OBSIDIAN_BROWSER_CHANNEL ? { channel: process.env.OBSIDIAN_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const checks = [];
try {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /same key|unique.*key/.test(message.text())) errors.push(message.text()); });
  await page.goto(`${baseUrl}/dashboard?view=knowledge&lang=zh`);
  const initial = await context.request.get(`${baseUrl}/api/dashboard/knowledge-assets`);
  assert.equal(initial.status(), 200);
  // Seed a same-title asset through the ordinary import endpoint.
  const seeded = await context.request.post(`${baseUrl}/api/dashboard/knowledge-assets`, { data: { kind: "text", title, sourceText: "现有资料必须保留，Obsidian 导入绝不覆盖或修改这段旧内容。" } });
  assert.equal(seeded.status(), 201);
  const existingId = (await seeded.json()).asset.id;
  await page.getByRole("button", { name: /导入知识/ }).click();
  const dialog = page.getByRole("dialog", { name: "导入知识" });
  await dialog.getByRole("button", { name: /第三方导入/ }).click();
  const panel = dialog.getByRole("region", { name: "Obsidian 本地导入" });
  const input = panel.locator('input[type="file"]');
  assert.equal(await input.getAttribute("webkitdirectory"), null);
  assert.equal(await input.getAttribute("multiple"), "");
  assert.equal(await input.getAttribute("accept"), ".md,.markdown");
  await input.setInputFiles([join(vault, `产品A/${filename}`), join(vault, `产品B/${filename}`)]);
  assert.equal(await panel.getByRole("checkbox", { name: `选择 ${filename}`, exact: true }).count(), 2);
  assert(await panel.getByText("已选 2 / 2 篇", { exact: true }).isVisible());
  await dialog.getByRole("button", { name: /开始上传 \(2\)/ }).waitFor();
  // A second selection adds files rather than replacing the first batch.
  await input.setInputFiles([join(vault, "共享规则.md"), join(vault, "私人/日记.md")]);
  await panel.getByRole("checkbox", { name: "选择 共享规则.md", exact: true }).uncheck();
  await panel.getByRole("checkbox", { name: "选择 日记.md", exact: true }).uncheck();
  assert(await panel.getByText("已选 2 / 4 篇", { exact: true }).isVisible());
  assert.equal(await dialog.getByRole("radio", { name: /仅 Owner/ }).isChecked(), true);
  await panel.getByRole("button", { name: "允许并勾选" }).waitFor();
  assert(!(await panel.textContent()).includes("测试售后标记"));
  assert(!(await panel.textContent()).includes("PRIVATE_UNSELECTED_NOTE_CONTENT"));
  assert.deepEqual(await panel.getByRole("textbox", { name: `修改 ${filename} 的名称`, exact: true }).evaluateAll((inputs) => inputs.map((input) => input.value)), [`${title}（2）`, `${title}（3）`]);
  checks.push("multiple file selection, additional batches and same-name files; unselected references stay unread");
  await panel.getByRole("button", { name: "允许并勾选" }).click();
  await dialog.getByRole("button", { name: /开始上传 \(3\)/ }).waitFor();
  await dialog.getByRole("button", { name: `预览 ${title}（2）.md`, exact: true }).click();
  const preview = page.getByRole("dialog", { name: "笔记预览", exact: true });
  assert((await preview.textContent()).includes("测试售后标记"));
  await preview.getByRole("button", { name: "关闭预览" }).click();
  // Removing a dependency rebuilds the content used by the preview dialog.
  await dialog.getByRole("button", { name: "移除 共享规则.md", exact: true }).click();
  await panel.getByRole("button", { name: "允许并勾选" }).waitFor();
  await panel.getByRole("button", { name: "允许并勾选" }).click();
  await dialog.getByRole("button", { name: /开始上传 \(3\)/ }).waitFor();
  checks.push("explicit reference consent and removal both rebuild the upload preview");
  await dialog.getByRole("button", { name: `预览 ${title}（2）.md`, exact: true }).click();
  await page.screenshot({ path: join(output, "preview-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth + 2));
  await page.screenshot({ path: join(output, "preview-mobile.png"), fullPage: false });
  await preview.getByRole("button", { name: "关闭预览" }).click();
  await page.setViewportSize({ width: 1440, height: 1100 });
  const submitted = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/knowledge-assets")) submitted.push(request.postData() || ""); });
  await dialog.getByRole("button", { name: /开始上传 \(3\)/ }).click();
  await dialog.getByText("3/3 已完成", { exact: true }).waitFor({ timeout: 60_000 });
  const assets = (await (await context.request.get(`${baseUrl}/api/dashboard/knowledge-assets`)).json()).assets;
  const imported = assets.filter((asset) => asset.obsidianImport?.sourcePath.startsWith("selected/"));
  assert.equal(imported.length, 3);
  assert.deepEqual(imported.map((asset) => asset.originalFileName).sort(), ["共享规则.md", `${title}（2）.md`, `${title}（3）.md`].sort());
  assert(imported.every((asset) => asset.status === "ready" && asset.visibility === "owner_only" && !asset.representativeLinks.length));
  const product = imported.find((asset) => asset.obsidianImport.properties.内部成本 === 99173);
  assert(product.extractedText.includes("测试售后标记"));
  assert(!product.extractedText.includes("99173"));
  assert(!product.extractedText.includes("不应嵌入产品"));
  assert.equal(product.obsidianImport.properties.内部成本, 99173);
  assert(submitted.every((body) => !body.includes("PRIVATE_UNSELECTED_NOTE_CONTENT")));
  assert.equal(assets.find((asset) => asset.id === existingId).title, title);
  checks.push("actual upload, ready indexing, private defaults, property persistence, selected heading expansion, existing asset preserved");
  // Replay the exact selected snapshot: creates another copy, never checksum-skips it.
  const copy = await context.request.post(`${baseUrl}/api/dashboard/knowledge-assets`, { multipart: {
    file: { name: filename, mimeType: "text/markdown", buffer: Buffer.from(product.extractedText) },
    obsidianImport: JSON.stringify(product.obsidianImport), conflictPolicy: "skip_duplicates",
  } });
  assert.equal(copy.status(), 201); const copied = await copy.json();
  assert.equal(copied.asset.originalFileName, `${title}（4）.md`); assert.notEqual(copied.asset.id, product.id);
  checks.push("identical repeat import creates a numbered copy rather than overwriting or skipping");
  assert.equal(await readFile(join(vault, `产品A/${filename}`), "utf8"), source);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, "completed.png"), fullPage: true });
  console.log(JSON.stringify({ passed: checks.length, checks, output, errors }, null, 2));
} finally { await context.close(); await browser.close(); }
