const captureButton = document.getElementById("capture");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
let snapshot = null;
captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  snapshot = null;
  preview.hidden = true;
  status.textContent = "正在读取当前网页…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("请先打开要采集的网页。");
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js"] });
    const result = injection?.result;
    if (!result || result.error) throw new Error(result?.error || "未能读取网页，请重新加载页面后再试。");
    snapshot = result;
    document.getElementById("title").textContent = result.title;
    document.getElementById("source").textContent = result.sourceUrl;
    document.getElementById("text").value = result.text;
    document.getElementById("count").textContent = `${result.text.length.toLocaleString()} 字符`;
    preview.hidden = false;
    status.textContent = "采集完成，请检查正文是否包含你需要的内容。";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "无法读取此页面。";
  } finally { captureButton.disabled = false; }
});
document.getElementById("download").addEventListener("click", () => {
  if (!snapshot) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80)}.delegate-webpage.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  status.textContent = "已保存采集文件。请返回 Delegate 选择该文件，确认后完成导入。";
});
