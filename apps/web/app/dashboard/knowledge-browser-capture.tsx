"use client";

import { useRef, useState } from "react";
import { knowledgeBrowserCaptureSchema, knowledgeCaptureUrlSchema, MAX_KNOWLEDGE_CAPTURE_BYTES, type KnowledgeBrowserCapture } from "@delegate/web-data/knowledge-web-capture";

export function KnowledgeBrowserCaptureForm({ zh, sourceUrl, capture, onCapture, confirmed, onConfirmed, disabled }: {
  zh: boolean;
  sourceUrl: string;
  capture: KnowledgeBrowserCapture | null;
  onCapture: (capture: KnowledgeBrowserCapture | null) => void;
  confirmed: boolean;
  onConfirmed: (confirmed: boolean) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const validUrl = knowledgeCaptureUrlSchema.safeParse(sourceUrl);
  async function readCapture(file: File | undefined) {
    if (!file) return;
    const current = ++sequence.current;
    setReading(true);
    setError(null);
    onCapture(null);
    onConfirmed(false);
    try {
      if (file.size > MAX_KNOWLEDGE_CAPTURE_BYTES) throw new Error(zh ? "采集文件不能超过 3 MB。" : "Capture files must not exceed 3 MB.");
      const parsed = knowledgeBrowserCaptureSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) throw new Error(zh ? `采集文件无效：${parsed.error.issues[0]?.message ?? "请重新采集"}` : "Invalid capture. Complete verification and capture the page again.");
      if (current === sequence.current) onCapture(parsed.data);
    } catch (error) {
      if (current === sequence.current) setError(error instanceof Error ? error.message : (zh ? "无法读取采集文件。" : "Unable to read capture."));
    } finally { if (current === sequence.current) setReading(false); }
  }
  return <section className="knowledge-browser-capture" aria-label={zh ? "浏览器采集" : "Browser capture"}>
    <p>{zh ? "使用本机浏览器的登录状态、代理和内网连接。完成网站验证后采集正文，确认后再保存到知识库。" : "Use your local browser’s signed-in session and network. Complete verification, capture the page, then review before importing."}</p>
    <ol>
      <li><a aria-disabled={!validUrl.success} href={validUrl.success ? validUrl.data : undefined} target="_blank" rel="noreferrer">{zh ? "打开来源网页" : "Open source page"} ↗</a><span>{zh ? "完成登录或验证码，等待正文加载。" : "Sign in or solve verification and wait for the content."}</span></li>
      <li><a href="/api/dashboard/knowledge-assets/browser-collector">{zh ? "下载浏览器采集工具" : "Download browser collector"}</a><span>{zh ? "在 Chrome / Edge 中安装一次，之后点击工具栏的采集按钮即可。" : "Install once in Chrome / Edge, then capture from the browser toolbar."}</span></li>
      <li>{zh ? "点击工具中的“验证完成，采集正文”，预览后保存采集文件。" : "Click “验证完成，采集正文” in the tool, review the text, and save the capture file."}</li>
    </ol>
    <details><summary>{zh ? "首次安装说明" : "First-time installation"}</summary><p>{zh ? "解压下载文件。在 Chrome 的扩展程序管理页（chrome://extensions）或 Edge 的扩展管理页开启“开发者模式”，选择“加载已解压的扩展程序”，选中解压文件夹。工具仅在你点击时读取当前网页正文。" : "Unzip the download. Open chrome://extensions or edge://extensions, enable Developer mode, choose Load unpacked, and select that folder. The tool reads the current page only when you click it."}</p></details>
    <label className="knowledge-form-field"><span>{zh ? "选择已采集的网页文件" : "Choose the captured page file"}</span><input accept=".json,.delegate-webpage.json" disabled={disabled || reading} onChange={(event) => { void readCapture(event.target.files?.[0]); event.currentTarget.value = ""; }} type="file" /></label>
    {reading ? <p role="status">{zh ? "正在读取采集文件…" : "Reading capture…"}</p> : null}
    {capture ? <>
      <p className="knowledge-capture-source"><strong>{zh ? "已采集来源" : "Captured source"}</strong><span>{capture.sourceUrl}</span><small>{zh ? "请核对跳转后的网址是否为你需要的页面。" : "Check that the final URL is the intended page."}</small></p>
      <label className="knowledge-form-field"><span>{zh ? "正文预览（可编辑）" : "Text preview (editable)"}</span><textarea disabled={disabled} maxLength={400_000} minLength={20} onChange={(event) => { onCapture({ ...capture, text: event.target.value }); onConfirmed(false); }} rows={8} value={capture.text} /><small>{capture.text.length.toLocaleString()} / 400,000</small></label>
      <label className="knowledge-capture-confirm"><input checked={confirmed} disabled={disabled} onChange={(event) => onConfirmed(event.target.checked)} type="checkbox" /><span>{zh ? "我已完成网站验证，确认以上是目标页面正文，并有权按下方可见范围导入。" : "I completed verification, reviewed this page’s content, and may import it with the selected visibility."}</span></label>
    </> : <p role="status">{zh ? "等待你完成验证并选择采集文件；取消后不会创建知识记录。" : "Waiting for verification and a capture file. Canceling creates no asset."}</p>}
    {error ? <p className="knowledge-form-error" role="alert">{error}</p> : null}
  </section>;
}
