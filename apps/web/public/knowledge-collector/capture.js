// Injected only into the active tab after the user clicks the extension.
(() => {
  const url = new URL(location.href);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return { error: "请在要采集的 HTTP/HTTPS 网页中打开采集工具。" };
  }
  const title = (document.title || url.hostname).trim().slice(0, 180);
  if (/^(百度安全验证|安全验证|访问验证|人机验证|请先登录|登录|login|sign in|just a moment(?:\.{3})?|access denied|verify you are human)[\s!！…]*$/i.test(title)) {
    return { error: "请先回到网页完成登录或安全验证，再重新采集。" };
  }
  const skip = "script,style,noscript,template,nav,footer,aside,form,input,textarea,select,button,iframe,canvas,svg,[hidden],[aria-hidden='true'],[contenteditable='true']";
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
  };
  function readText(root) {
    const parts = [];
    let length = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        length += text.length;
        if (length > 800_000) throw new Error("网页正文过长，请选中需要的段落后重新采集。");
        parts.push(text);
        return;
      }
      if (!(node instanceof Element) || node.matches(skip) || !visible(node)) return;
      if (node.tagName === "HEADER" && !node.closest("article,main,[role=main]")) return;
      const block = /^(block|flex|grid|table|list-item)/.test(getComputedStyle(node).display) || node.tagName === "BR";
      if (block) parts.push("\n");
      for (const child of node.childNodes) walk(child);
      if (block) parts.push("\n");
    }
    walk(root);
    return parts.join("").replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  try {
    // User selection takes precedence. Otherwise prefer article/main and fall back to visible body text.
    const selection = window.getSelection();
    const selectionElement = selection?.anchorNode?.parentElement;
    const selectedText = selectionElement?.closest("input,textarea,[contenteditable='true']") ? "" : selection?.toString().trim();
    let text = selectedText || "";
    if (!text) {
      const candidates = [...document.querySelectorAll("article,main,[role='main']")].filter((element) => {
        for (let current = element; current; current = current.parentElement) {
          if (current.matches("[hidden],[aria-hidden='true']") || !visible(current)) return false;
        }
        return true;
      });
      const texts = candidates.map(readText).filter((value) => value.length >= 20);
      text = texts.sort((a, b) => b.length - a.length)[0] || readText(document.body);
    }
    if (text.length < 20) return { error: "没有采集到足够正文。请完成验证、展开或滚动加载正文后再试；也可以先选中所需段落。" };
    if (text.length > 400_000) return { error: "正文超过 400,000 字符，请选中需要的段落后重新采集。" };
    return {
      format: "delegate-web-capture", version: 1,
      sourceUrl: url.href, title, text, capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "采集失败，请重新打开网页后再试。" };
  }
})();
