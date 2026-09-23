// DOM regression tests use a local virtual document, never a signed-in external site.
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.BROWSER_CAPTURE_PLAYWRIGHT_MODULE || "playwright");
const source = await readFile(new URL("../../apps/web/public/knowledge-collector/capture.js", import.meta.url), "utf8");
const server = createServer((_req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<title>\u200b完整文档测试 - 云文档</title><body></body>'); });
server.listen(0,'127.0.0.1'); await once(server,'listening');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const checks=[];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.setContent(`<title>完整文档测试</title><aside>目录导航：第一部分、第二部分</aside><div class="page-block root-block" data-slate-editor="true" data-content-editable-root="true" contenteditable="true"><h1>完整文档测试</h1><div data-block-id="1" data-record-id="one" data-block-type="text"><div contenteditable="true">正文包含业务背景和关键说明，不应该因为在线文档可编辑而被删除。</div></div><div data-block-id="2" data-record-id="two" data-block-type="text"><div contenteditable="true">第二部分的详细步骤，不能只采集目录标题。</div></div><form><input type="password" value="secret"><textarea>表单值不能被采集</textarea></form></div><div contenteditable="true" role="textbox">评论草稿不能被采集</div>`);
  await page.evaluate(() => { const range=document.createRange();range.selectNodeContents(document.querySelector('[data-record-id="one"]'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range); });
  const editable=await page.evaluate(source);
  assert(editable.text?.includes('正文包含业务背景'), JSON.stringify(editable));
  assert(editable.text.includes('第二部分的详细步骤'));
  assert(!/目录导航|评论草稿|表单值|secret/.test(editable.text));
  checks.push('editable document body included; navigation, comments and form values excluded');

  await page.setContent('<title>虚拟滚动文档</title><aside>目录不能替代正文</aside><div id="scroll" style="height:240px;overflow-y:auto"><div class="page-block root-block" data-slate-editor="true" data-content-editable-root="true" contenteditable="true" style="height:2400px;position:relative"><h1>虚拟滚动文档</h1><div id="blocks"></div></div></div>');
  await page.evaluate(() => {
    const scroller=document.querySelector('#scroll'), blocks=document.querySelector('#blocks');
    const rows=Array.from({length:12},(_,i)=>i===3||i===7?'相同句子必须在两个位置各保留一次。':`第${i+1}段完整正文，包含这一段独有的说明与结尾标记。`);
    function render(){ const start=Math.max(0,Math.floor(scroller.scrollTop/200)-1); const end=Math.min(12,start+4); blocks.innerHTML=rows.slice(start,end).map((text,j)=>`<div data-block-id="${start+j}" data-record-id="record-${start+j}" data-block-type="text" style="position:absolute;top:${(start+j)*200+40}px;height:120px"><div contenteditable="true">${text}</div></div>`).join(''); }
    let timer; scroller.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(render,100);}); render(); scroller.scrollTop=1000;
  });
  await page.waitForTimeout(200);
  const result=await page.evaluate(source);
  assert(!result.error,JSON.stringify(result));
  for(const i of [1,2,3,5,6,7,9,10,11,12]) assert(result.text.includes(`第${i}段完整正文`),`missing paragraph ${i}: ${result.text}`);
  assert.equal((result.text.match(/相同句子必须在两个位置各保留一次。/g)||[]).length,2);
  assert(result.text.indexOf('第1段')<result.text.indexOf('第12段'));
  assert(!result.text.includes('目录不能替代正文'));
  assert.equal(await page.locator('#scroll').evaluate(e=>e.scrollTop),1000);
  checks.push('virtualized body read from start to end in order, with stable block deduplication and position restored');

  await page.evaluate(()=>{const root=document.querySelector('.root-block'); root.innerHTML='<h1>超限文档</h1><div data-block-id="huge" data-record-id="huge" data-block-type="text">'+'文'.repeat(400001)+'</div>';});
  assert((await page.evaluate(source)).error);
  assert.equal(await page.locator('#scroll').evaluate(e=>e.scrollTop),1000);
  checks.push('oversized document rejected and original scroll position restored on failure');
  console.log(JSON.stringify({passed:checks.length,checks},null,2));
} finally {await browser.close();server.close();}
