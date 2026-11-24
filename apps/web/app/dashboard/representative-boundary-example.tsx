"use client";
import { useId, useRef, useState } from "react";
import {
  boundaryLabels,
  boundaryPresets,
  type KnowledgeSettings,
} from "@delegate/domain/representative-knowledge-settings";

export function RepresentativeBoundaryExample({
  rule,
}: {
  rule: KnowledgeSettings["boundaries"][number];
}) {
  const id = useId(),
    button = useRef<HTMLButtonElement>(null),
    card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const preset = boundaryPresets.find((p) => p.id === rule.id);
  function show() {
    const el = card.current,
      anchor = button.current;
    if (!el || !anchor) return;
    el.showPopover();
    const rect = anchor.getBoundingClientRect(),
      box = el.getBoundingClientRect();
    el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12))}px`;
    el.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - box.height - 12))}px`;
    setOpen(true);
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="d-sb-help"
        aria-label={`查看${preset?.name || "自定义场景"}的处理示例`}
        aria-expanded={open}
        aria-controls={id}
        onMouseEnter={show}
        onFocus={show}
        onClick={show}
      >
        ?
      </button>
      <div
        id={id}
        ref={card}
        popover="auto"
        className="d-sb-example-card"
        role="tooltip"
        onToggle={(e) => setOpen(e.newState === "open")}
      >
        <div className="d-sb-example-head">
          <strong>{preset?.name || rule.request || "自定义场景"}</strong>
          <span>处理示例</span>
        </div>
        <div className="d-sb-dialogue">
          <div>
            <small>访客</small>
            <p>
              {preset?.example ||
                rule.request ||
                "填写请求场景后，可在这里查看示例。"}
            </p>
          </div>
          <div className="d-sb-reply">
            <small>对外代理</small>
            <p>
              {rule.action === "approve"
                ? "这件事需要本人确认。我会先整理你的需求并提交审批，确认结果会再告诉你。"
                : rule.action === "handoff"
                  ? "这件事适合由本人和你继续沟通。我可以按当前人工服务条件发起接手申请，请先告诉我需要处理的具体问题。"
                  : "抱歉，目前不提供这类服务。我可以继续帮你了解已提供的服务范围。"}
            </p>
          </div>
          <span className="d-badge teal">{boundaryLabels[rule.action]}</span>
        </div>
        {rule.id === "discount" && (
          <p className="d-sb-example-note">
            只询问已公布的价格时，正常回答即可。
          </p>
        )}
        <p className="d-sb-example-note">仅演示处理方式，不会执行真实操作。</p>
      </div>
    </>
  );
}
