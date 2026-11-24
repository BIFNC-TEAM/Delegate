"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { RepresentativeDirectoryItem } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";
import {
  onboardingDraftSchema,
  type OnboardingDraft,
} from "@delegate/domain/representative-onboarding";
import { RepresentativeOnboarding } from "./representative-onboarding";
import { RepresentativeAvatar } from "./representative-avatar-editor";
import {
  WorkbenchIcon,
  WorkbenchPanelHeading,
} from "./representative-workbench";
import "./representative-basic-info.css";

export function DashboardRepresentativeDirectory({
  ownerId,
  activeSlug,
  initialOwnerName,
  initialRepresentatives,
  locale,
  representativeBaseUrl,
}: {
  ownerId: string;
  activeSlug: string;
  initialOwnerName: string;
  initialRepresentatives: RepresentativeDirectoryItem[];
  locale: Locale;
  representativeBaseUrl: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const key = `delegate:onboarding:v1:${ownerId}`;
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      const value = localStorage.getItem(key);
      const parsed = value
        ? onboardingDraftSchema.safeParse(JSON.parse(value))
        : null;
      setDraft(parsed?.success ? parsed.data : null);
    } catch {
      setNotice("浏览器无法恢复创建进度，可以重新开始。");
    }
    setLoaded(true);
  }, [key]);
  function change(next: OnboardingDraft) {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setNotice("浏览器无法保留进度，请勿关闭当前页面，填写内容仍可提交。");
    }
  }
  function start() {
    if (!draft)
      change({
        version: 1,
        requestId: crypto.randomUUID(),
        step: 0,
        fields: [],
        customField: "",
        name: Array.from(`${initialOwnerName}的对外代理`).slice(0, 60).join(""),
        services: "",
        tone: 0,
        avatarUrl: "",
      });
    setOpen(true);
  }
  useEffect(() => {
    if (loaded && searchParams.get("create") === "1") {
      start();
      const url = new URL(window.location.href);
      url.searchParams.delete("create");
      window.history.replaceState(null, "", url);
    }
  }, [loaded, searchParams]);

  function created(slug: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* A repeated submission uses the same request ID. */
    }
    setOpen(false);
    setDraft(null);
    router.push(
      `/dashboard?rep=${encodeURIComponent(slug)}&view=representatives&repSection=setup&setupSection=basics&lang=${locale}`,
    );
    router.refresh();
  }
  if (open && draft)
    return (
      <>
        <div className="d-page-title">
          <h1>创建对外代理</h1>
        </div>
        <RepresentativeOnboarding
          draft={draft}
          ownerName={initialOwnerName}
          locale={locale}
          onChange={change}
          onExit={() => setOpen(false)}
          onCreated={created}
        />
      </>
    );
  return (
    <>
      <div className="d-page-title">
        <h1>我的对外代理</h1>
      </div>
      <section className="d-panel d-directory-panel">
        <header className="d-panel-head">
          <WorkbenchPanelHeading
            icon="bot"
            title="我的对外代理"
            description="通过几个简单问题，创建一个了解你的对外代理。"
          />
          <button
            className="d-button d-primary"
            type="button"
            disabled={!loaded}
            onClick={start}
          >
            <WorkbenchIcon name="plus" />
            创建对外代理
          </button>
        </header>
        <div className="d-panel-body">
          {notice ? (
            <p className="d-help" role="status">
              {notice}
            </p>
          ) : null}
          {draft ? (
            <div className="d-generated-note d-between">
              <div>
                <strong>创建引导进行中 · {draft.name}</strong>
                <p>第 {draft.step + 1} / 4 步，已保留填写内容</p>
              </div>
              <button type="button" className="d-button" onClick={start}>
                继续创建
              </button>
            </div>
          ) : null}
          {!initialRepresentatives.length ? (
            <p className="d-empty">
              还没有对外代理，创建你的第一个对外代理吧。
            </p>
          ) : null}
          {initialRepresentatives.map((rep) => (
            <article className="d-item-row" key={rep.id}>
              <RepresentativeAvatar name={rep.name} url={rep.avatarUrl} />
              <div>
                <h3>{rep.name}</h3>
                <div className="d-agent-id">
                  <span className="d-agent-id-label">ID</span>
                  <code>{rep.slug}</code>
                  <button
                    className="d-button d-ghost d-id-copy"
                    aria-label={`复制 ${rep.name} 的 ID`}
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(rep.slug)
                        .then(() => setNotice("已复制"))
                        .catch(() =>
                          setNotice(`复制失败，请手动复制：${rep.slug}`),
                        );
                    }}
                  >
                    <WorkbenchIcon name="copy" />
                  </button>
                </div>
                <p className="d-muted d-small">{rep.tagline}</p>
                <span className="d-small">
                  {rep.activeVersion
                    ? `已发布 · v${rep.activeVersion}`
                    : "未发布"}
                </span>
              </div>
              <div className="d-directory-actions">
                {rep.activeVersion && rep.publicMode ? (
                  <a
                    className="d-button"
                    href={`${representativeBaseUrl}/reps/${encodeURIComponent(rep.slug)}?lang=${locale}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <WorkbenchIcon name="inbox" />
                    公开页面 ↗
                  </a>
                ) : null}
                <Link
                  className="d-button"
                  href={`/dashboard?rep=${encodeURIComponent(rep.slug)}&view=representatives&repSection=setup&setupSection=basics&lang=${locale}`}
                >
                  继续配置
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
