// Injected only into the active tab after the user clicks the extension.
(async () => {
  const url = new URL(location.href);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return { error: "请在要采集的 HTTP/HTTPS 网页中打开采集工具。" };
  }
  const clean = (text) => text.replace(/[\u200b\ufeff]/g, "").replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const title = clean(document.title || url.hostname).replace(/[\u200c-\u200f\u202a-\u202e\u2060-\u206f]/g, "").slice(0, 180);
  if (/^(百度安全验证|安全验证|访问验证|人机验证|请先登录|登录|login|sign in|just a moment(?:\.{3})?|access denied|verify you are human)[\s!！…]*$/i.test(title)) {
    return { error: "请先回到网页完成登录或安全验证，再重新采集。" };
  }
  const documentSelector = '[data-slate-editor="true"][data-content-editable-root="true"]';
  const blockSelector = "[data-block-type][data-block-id]";
  const skip = "script,style,noscript,template,nav,footer,aside,form,input,textarea,select,button,iframe,canvas,svg,[hidden],[aria-hidden='true']";
  const editable = '[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
  };
  const visibleTree = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.matches("[hidden],[aria-hidden='true']") || !visible(current)) return false;
    }
    return true;
  };
  function readText(root, allowDocumentEditing = false) {
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
      if (!allowDocumentEditing && node.matches(editable)) return;
      if (node.tagName === "HEADER" && !allowDocumentEditing && !node.closest("article,main,[role=main]")) return;
      const block = /^(block|flex|grid|table|list-item)/.test(getComputedStyle(node).display) || node.tagName === "BR";
      if (block) parts.push("\n");
      for (const child of node.childNodes) walk(child);
      if (block) parts.push("\n");
    }
    if (root) walk(root);
    return clean(parts.join(""));
  }
  async function readVirtualDocument(root) {
    // Online documents may unmount earlier blocks as later blocks enter the viewport.
    // Collect by stable block identity while moving forward, never by text (repeated paragraphs are valid).
    let scroller = root;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 4)) scroller = scroller.parentElement;
    scroller ||= document.scrollingElement;
    const originalTop = scroller?.scrollTop ?? 0;
    const originalLeft = scroller?.scrollLeft ?? 0;
    const blocks = new Map();
    let characters = 0;
    let heading = "";
    const started = Date.now();
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const moveTo = (top) => scroller?.scrollTo({ top, left: originalLeft, behavior: "instant" });
    let finished = false;
    let bottomChecks = 0;
    let previousHeight = -1;
    try {
      moveTo(0);
      await pause(500);
      for (let step = 0; step < 150 && Date.now() - started < 60_000; step += 1) {
        if (!root.isConnected || location.href !== url.href) throw new Error("采集期间页面发生变化，请在目标文档中重新采集。");
        heading ||= readText(root.querySelector("h1"), true);
        const nodes = [...root.querySelectorAll(blockSelector)].filter((element) => {
          const parentBlock = element.parentElement?.closest(blockSelector);
          return (!parentBlock || !root.contains(parentBlock)) && visibleTree(element);
        });
        if (!nodes.length) throw new Error("未找到文档正文块，请等待文档加载或选中正文后重新采集。");
        let changed = false;
        for (const node of nodes) {
          const key = node.getAttribute("data-record-id") || node.getAttribute("data-block-id");
          const text = readText(node, true);
          if (!text) continue;
          if (blocks.get(key) !== text) {
            characters += text.length - (blocks.get(key)?.length ?? 0);
            blocks.set(key, text);
            changed = true;
          }
        }
        if (characters + blocks.size * 2 + heading.length > 400_000) throw new Error("文档正文超过 400,000 字符，请拆分文档后导入。");
        const height = scroller?.scrollHeight ?? 0;
        const top = scroller?.scrollTop ?? 0;
        const viewport = scroller?.clientHeight ?? 0;
        const atBottom = top + viewport >= height - 4;
        bottomChecks = atBottom && height === previousHeight && !changed ? bottomChecks + 1 : 0;
        if (bottomChecks >= 3) { finished = true; break; }
        previousHeight = height;
        if (!atBottom) moveTo(Math.min(height - viewport, top + Math.max(80, viewport * 0.65)));
        await pause(atBottom ? 800 : 450);
      }
      if (!finished) throw new Error("文档仍在加载，未能确认完整正文。请等待加载完成后重试，或导出原文件导入。");
      return clean([heading, ...blocks.values()].filter(Boolean).join("\n\n"));
    } finally {
      moveTo(originalTop);
    }
  }
  try {
    const documentRoot = [...document.querySelectorAll(documentSelector)].find(visibleTree);
    const selection = window.getSelection();
    const selectionElement = selection?.anchorNode?.parentElement;
    const selectionIsInput = selectionElement?.closest("input,textarea,form") || (selectionElement?.closest(editable) && !documentRoot?.contains(selectionElement));
    // A cloud editor's select-all may cover only the currently mounted blocks.
    // Always traverse recognized documents, even when a stale partial selection exists.
    let text = documentRoot
      ? await readVirtualDocument(documentRoot)
      : selectionIsInput ? "" : clean(selection?.toString() || "");
    if (!text) {
      const candidates = [...document.querySelectorAll("article,main,[role='main'],[role='document']")].filter(visibleTree);
      const texts = candidates.map((element) => readText(element)).filter((value) => value.length >= 20);
      text = texts.sort((a, b) => b.length - a.length)[0] || readText(document.body);
    }
    if (text.length < 20) return { error: "没有采集到足够正文。请完成验证、展开或滚动加载正文后再试；也可以先选中所需段落。" };
    if (text.length > 400_000) return { error: "正文超过 400,000 字符，请选中需要的段落后重新采集。" };
    return { format: "delegate-web-capture", version: 1, sourceUrl: url.href, title, text, capturedAt: new Date().toISOString() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "采集失败，请重新打开网页后再试。" };
  }
})();
