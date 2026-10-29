"use client";

import { useEffect, useRef, useState } from "react";
import { copyFor, type MarketingLocale } from "./marketing-copy";

// Supplied review drafts, not binding legal documents or authentication terms.
export function PolicyDocuments({ locale }: { locale: MarketingLocale }) {
  const t = copyFor(locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [kind, setKind] = useState<"terms" | "privacy">("terms");
  const [body, setBody] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => () => request.current?.abort(), []);
  async function openDocument(value: "terms" | "privacy") {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setKind(value);
    setFailed(false);
    setBody(t("正在读取文档…", "Loading document…"));
    if (!dialog.current?.open) dialog.current?.showModal();
    try {
      const response = await fetch(`/marketing/${value}-review.txt`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Document unavailable");
      const content = await response.text();
      if (!controller.signal.aborted)
        setBody(content.replace(/^#{1,3} /gm, "").replace(/\*\*/g, ""));
    } catch {
      if (!controller.signal.aborted) {
        setBody(
          t(
            "暂时无法读取文档，请稍后重试。",
            "The document could not be loaded. Please try again.",
          ),
        );
        setFailed(true);
      }
    }
  }
  return (
    <>
      <button onClick={() => void openDocument("terms")}>
        {t("用户协议", "Terms")}
      </button>
      <button onClick={() => void openDocument("privacy")}>
        {t("隐私政策", "Privacy")}
      </button>
      <dialog
        ref={dialog}
        className="policy-dialog"
        aria-labelledby="document-title"
        aria-describedby="document-note"
        onClose={() => request.current?.abort()}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            dialog.current?.close();
        }}
      >
        <div className="dialog-head">
          <h2 id="document-title">
            {kind === "privacy"
              ? t("隐私政策 · 审阅稿", "Privacy policy · Review draft")
              : t("用户协议 · 审阅稿", "Terms of use · Review draft")}
          </h2>
          <button
            aria-label={t("关闭文档", "Close document")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p className="document-note" id="document-note">
          {t(
            "审阅稿 · 尚待补齐运营主体及实际处理规则，未作为正式条款生效。",
            "Review draft in Chinese. Operator details and handling rules are incomplete; these are not effective legal terms.",
          )}
        </p>
        <div className="document-body" lang="zh-CN" aria-live="polite">
          {body}
        </div>
        {failed && (
          <button
            className="button secondary"
            onClick={() => void openDocument(kind)}
          >
            {t("重试", "Retry")}
          </button>
        )}
      </dialog>
    </>
  );
}
