// Run against an isolated Dashboard in demo mode; never point at a production workspace.
// BROWSER_CAPTURE_PLAYWRIGHT_MODULE may point to an existing Playwright tool installation.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.BROWSER_CAPTURE_PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.BROWSER_CAPTURE_TEST_URL || "http://127.0.0.1:3311";
if (!["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname)) throw new Error("Use a local, isolated demo Dashboard.");
const output = process.env.BROWSER_CAPTURE_TEST_OUTPUT || "/tmp/delegate-browser-capture-test";
await mkdir(output, { recursive: true });
const source = await readFile(new URL("../../apps/web/public/knowledge-collector/capture.js", import.meta.url), "utf8");
const paragraph = "只有在本机浏览器完成登录后才能读取这份内部资料。这些内容用于验证网页知识采集、权限确认和重新处理，不包含真实账号信息。";
const fixture = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (new URL(req.url, "http://localhost").pathname === "/signin") { res.writeHead(302, { "Set-Cookie": "test_session=ok; HttpOnly; SameSite=Lax", Location: "/wiki" }); res.end(); return; }
  if (!(req.headers.cookie || "").includes("test_session=ok")) {
    res.end('<title>登录</title><form action="/signin"><label>账号<input name="user"></label><label>密码<input type="password" name="password"></label><button>登录</button></form>'); return;
  }
  res.end(`<title>已登录内网采集验证</title><header>站点导航</header><nav>不应包含导航</nav><main><header><h1>内部知识正文</h1></header><p id="body-text">${paragraph}</p><div hidden>不可见机密文本</div><form><input type="password" value="fixture-secret"><textarea>不应读取表单值</textarea></form><p style="display:none">不应包含隐藏内容</p></main><footer>不应包含页脚菜单</footer>`);
});
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/wiki`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const checks = [];
try {
  const sourcePage = await context.newPage();
  await sourcePage.goto(fixtureUrl);
  assert.match((await sourcePage.evaluate(source)).error, /登录|验证/); checks.push("login page rejected before manual verification");
  await sourcePage.getByLabel("账号").fill("fixture-user");
  await sourcePage.getByLabel("密码").fill("fixture-password");
  await sourcePage.getByRole("button", { name: "登录" }).click();
  await sourcePage.waitForURL(fixtureUrl);
  const capture = await sourcePage.evaluate(source);
  assert.equal(capture.sourceUrl, fixtureUrl);
  assert(capture.text.includes(paragraph)); assert(capture.text.includes("内部知识正文"));
  assert(!/导航|fixture-secret|表单值|隐藏|机密|页脚/.test(capture.text));
  checks.push("signed-in internal page captured; hidden text, form fields and navigation excluded");
  await sourcePage.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector("#body-text")); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  assert.equal((await sourcePage.evaluate(source)).text, paragraph); checks.push("explicit text selection preserved");
  await sourcePage.evaluate(() => { document.querySelector("#body-text").textContent = "x".repeat(400001); });
  assert((await sourcePage.evaluate(source)).error); checks.push("oversized content rejected");
  await writeFile(`${output}/capture.delegate-webpage.json`, JSON.stringify(capture, null, 2));
  const page = await context.newPage();
  const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/dashboard?view=knowledge&lang=zh`);
  await page.getByRole("button", { name: /导入知识/ }).click();
  await page.getByRole("button", { name: /导入网址/ }).click();
  const dialog = page.getByRole("dialog", { name: "导入知识" });
  await dialog.getByLabel("来源网址").fill(fixtureUrl);
  const submit = dialog.getByRole("button", { name: /开始处理/ });
  assert(await submit.isDisabled());
  await dialog.getByLabel("选择已采集的网页文件").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{broken") });
  await dialog.getByRole("alert").waitFor(); assert(await submit.isDisabled()); checks.push("invalid capture stays unsubmitted");
  await dialog.getByLabel("选择已采集的网页文件").setInputFiles(`${output}/capture.delegate-webpage.json`);
  await dialog.getByLabel("正文预览（可编辑）").waitFor();
  assert(await submit.isDisabled());
  await dialog.getByRole("checkbox", { name: /我已完成网站验证/ }).check();
  assert(await submit.isEnabled());
  await dialog.getByLabel("正文预览（可编辑）").fill(capture.text + "\n已人工核对。");
  assert(await submit.isDisabled());
  await dialog.getByRole("checkbox", { name: /我已完成网站验证/ }).check();
  await page.screenshot({ path: `${output}/preview-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/preview-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/dashboard/knowledge-assets") && response.request().method() === "POST");
  await submit.click();
  const response = await createdResponse; assert.equal(response.status(), 201);
  const { asset: created } = await response.json();
  let ready;
  for (let i=0;i<40;i++) { ready=(await (await context.request.get(`${baseUrl}/api/dashboard/knowledge-assets/${created.id}`)).json()).asset; if (ready?.status !== "processing") break; await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.equal(ready.status, "ready"); assert.equal(ready.sourceUrl, fixtureUrl); assert(ready.extractedText.includes(paragraph));
  checks.push("preview requires confirmation; edits reset confirmation; real import becomes ready");
  const repairTitle = `失败网址补充测试-${Date.now()}`;
  const failedResponse = await context.request.post(`${baseUrl}/api/dashboard/knowledge-assets`, { data: { kind: "url", title: repairTitle, sourceUrl: fixtureUrl } });
  const { asset: failed } = await failedResponse.json();
  for (let i=0;i<40;i++) { const asset=(await (await context.request.get(`${baseUrl}/api/dashboard/knowledge-assets/${failed.id}`)).json()).asset; if(asset?.status==='failed') break; await new Promise(resolve=>setTimeout(resolve,250)); }
  await page.reload();
  await page.getByRole("row").filter({ hasText: repairTitle }).getByRole("button", { name: "查看详情" }).click();
  await page.getByRole("button", { name: /浏览器采集/ }).click();
  await page.getByLabel("选择已采集的网页文件").setInputFiles(`${output}/capture.delegate-webpage.json`);
  await page.getByRole("checkbox", { name: /我已完成网站验证/ }).check();
  const repairedResponse=page.waitForResponse(r=>r.url().endsWith(`/knowledge-assets/${failed.id}/browser-capture`));
  await page.getByRole("button", { name: /开始处理/ }).click();
  assert.equal((await repairedResponse).status(),202);
  for(let i=0;i<40;i++){ ready=(await (await context.request.get(`${baseUrl}/api/dashboard/knowledge-assets/${failed.id}`)).json()).asset; if(ready?.status!=='processing')break;await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.equal(ready.status,'ready');assert.equal(ready.id,failed.id);assert.equal(ready.title,repairTitle);
  checks.push("failed URL repaired in place through UI");
  assert.deepEqual(pageErrors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, sourceUrl: fixtureUrl, createdId: created.id, repairedId: failed.id, pageErrors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} finally { await context.close(); await browser.close(); fixture.close(); }
