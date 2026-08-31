"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState, useTransition } from "react";
import type { RepresentativeDirectoryItem } from "@delegate/web-data";
import { buildLocalizedHref, pickCopy, type Locale } from "@delegate/web-ui";

type CreateRepresentativeFieldErrors = Partial<{
  ownerName: string;
  representativeName: string;
}>;

export function DashboardRepresentativeDirectory({
  activeSlug,
  initialOwnerName,
  initialRepresentatives,
  locale,
  representativeBaseUrl,
}: {
  activeSlug: string;
  initialOwnerName: string;
  initialRepresentatives: RepresentativeDirectoryItem[];
  locale: Locale;
  representativeBaseUrl: string;
}) {
  const router = useRouter();
  const t = pickCopy(locale, copy);
  const [representatives, setRepresentatives] = useState(initialRepresentatives);
  const [ownerName] = useState(initialOwnerName);
  const [representativeName, setRepresentativeName] = useState("");
  const [slug, setSlug] = useState("");
  const [tagline, setTagline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CreateRepresentativeFieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const trimmedOwnerName = ownerName.trim();
  const trimmedRepresentativeName = representativeName.trim();
  const isCreateDisabled = isPending || !trimmedOwnerName || !trimmedRepresentativeName;

  function clearFieldError(fieldName: keyof CreateRepresentativeFieldErrors) {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[fieldName];
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setMessage(null);

    const nextFieldErrors: CreateRepresentativeFieldErrors = {};
    if (!trimmedOwnerName) {
      nextFieldErrors.ownerName = t.ownerNameRequired;
    }
    if (!trimmedRepresentativeName) {
      nextFieldErrors.representativeName = t.representativeNameRequired;
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError(t.requiredFields);
      return;
    }

    startTransition(() => {
      void (async () => {
        const response = await fetch("/api/dashboard/representatives", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ownerName,
            representativeName,
            slug,
            tagline,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
            fieldErrors?: CreateRepresentativeFieldErrors;
          } | null;
          setFieldErrors(payload?.fieldErrors ?? {});
          throw new Error(payload?.error ?? t.createError);
        }

        const created = (await response.json()) as {
          id: string;
          slug: string;
          ownerName: string;
          name: string;
          tagline: string;
        };

        const nextList = [
          {
            id: created.id,
            slug: created.slug,
            ownerName: created.ownerName,
            name: created.name,
            tagline: created.tagline,
            updatedAt: new Date().toISOString(),
            lifecycleState: "draft",
            activeVersion: null,
          },
          ...representatives.filter((item) => item.slug !== created.slug),
        ];

        setRepresentatives(nextList);
        setRepresentativeName("");
        setSlug("");
        setTagline("");
        setMessage(t.createdMessage(created.name));
        router.push(
          `/dashboard?rep=${encodeURIComponent(created.slug)}&view=representatives&repSection=setup&lang=${locale}`,
        );
        router.refresh();
      })().catch((nextError: unknown) => {
        setError(
          nextError instanceof Error
            ? nextError.message
            : t.createError,
        );
      });
    });
  }

  return (
    <section className="representative-directory-workspace">
      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <div className="representative-directory-layout">
        <article className="representative-create-panel">
          <div className="representative-panel-heading">
            <div>
              <p>{t.workspaceEyebrow}</p>
              <h2>{t.createTitle}</h2>
              <span>{t.createCopy}</span>
            </div>
            <b>{t.entryScope}</b>
          </div>

          <form className="representative-create-form" onSubmit={handleSubmit}>
            <div className="representative-owner-context">
              <span>{t.ownerName}</span>
              <strong>{ownerName}</strong>
              <small>
                {locale === "zh"
                  ? "新代表自动归属当前 Owner；Owner 资料在工作区设置中统一维护。"
                  : "The new representative belongs to the current owner. Manage owner details in workspace settings."}
              </small>
            </div>

            <div className="representative-create-fields">
              <label className="field-stack">
                <span>{t.representativeName}</span>
                <input
                  aria-describedby={fieldErrors.representativeName ? "representative-name-error" : undefined}
                  aria-invalid={Boolean(fieldErrors.representativeName)}
                  className="text-input"
                  onChange={(event) => {
                    setRepresentativeName(event.target.value);
                    clearFieldError("representativeName");
                  }}
                  placeholder={t.representativePlaceholder}
                  value={representativeName}
                />
                {fieldErrors.representativeName ? (
                  <span className="field-error" id="representative-name-error">
                    {fieldErrors.representativeName}
                  </span>
                ) : null}
              </label>

              <label className="field-stack">
                <span>Slug</span>
                <input
                  className="text-input"
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="lin-founder-rep"
                  value={slug}
                />
                <small>{t.slugHint}</small>
              </label>

              <label className="field-stack field-span-full">
                <span>{t.tagline}</span>
                <textarea
                  className="text-input textarea-input"
                  onChange={(event) => setTagline(event.target.value)}
                  placeholder={t.taglinePlaceholder}
                  rows={3}
                  value={tagline}
                />
              </label>
            </div>

            <div className="representative-create-footer">
              <p>{isCreateDisabled && !isPending ? t.requiredFields : t.createNextStep}</p>
              <button className="dashboard-v2-button-primary" disabled={isCreateDisabled} type="submit">
                {isPending ? t.creating : t.createAction}
              </button>
            </div>
          </form>
        </article>

        <aside className="representative-directory-panel">
          <div className="representative-panel-heading is-compact">
          <div>
              <p>{t.workspaceTitle}</p>
              <h2>{t.publishedTitle}</h2>
              <span>{t.publishedCopy}</span>
          </div>
            <b>{t.repCount(representatives.length)}</b>
          </div>

          <div className="directory-list">
          {representatives.length === 0 ? (
            <div className="representative-directory-empty">
              <span>02</span>
              <h3>{t.emptyTitle}</h3>
              <p>{t.emptyCopy}</p>
            </div>
          ) : null}
          {representatives.map((representative) => {
            const isActive = representative.slug === activeSlug;

            return (
              <article
                className={isActive ? "directory-card directory-card-active" : "directory-card"}
                key={representative.id}
              >
                <div>
                  <p className="panel-title">
                    {representative.ownerName} · {representative.activeVersion
                      ? t.publishedVersion(representative.activeVersion)
                      : t.unpublished}
                  </p>
                  <h3>{representative.name}</h3>
                  <p>{representative.tagline}</p>
                </div>

                <div className="button-row button-row-stretch">
                  <Link
                    className={isActive ? "button-primary button-block" : "button-secondary button-block"}
                    href={`/dashboard?rep=${representative.slug}&view=representatives&repSection=operations&lang=${locale}`}
                  >
                    {isActive ? t.currentWorkspace : t.openWorkspace}
                  </Link>
                  {representative.activeVersion ? (
                    <a
                      className="button-secondary button-block"
                      href={buildLocalizedHref(`${representativeBaseUrl}/reps/${representative.slug}`, locale)}
                    >
                      {t.publicPage}
                    </a>
                  ) : (
                    <button className="button-secondary button-block" disabled type="button">
                      {t.publishFirst}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          </div>
        </aside>
      </div>
    </section>
  );
}

const copy: Record<
  Locale,
  {
    createError: string;
    createdMessage: (name: string) => string;
    requiredFields: string;
    workspaceEyebrow: string;
    workspaceTitle: string;
    workspaceCopy: string;
    createTitle: string;
    createCopy: string;
    entryScope: string;
    ownerName: string;
    ownerNameRequired: string;
    representativeName: string;
    representativeNameRequired: string;
    representativePlaceholder: string;
    tagline: string;
    taglinePlaceholder: string;
    slugHint: string;
    creating: string;
    createAction: string;
    createNextStep: string;
    publishedTitle: string;
    publishedCopy: string;
    publishedVersion: (version: number) => string;
    unpublished: string;
    emptyTitle: string;
    emptyCopy: string;
    repCount: (count: number) => string;
    currentWorkspace: string;
    openWorkspace: string;
    publicPage: string;
    publishFirst: string;
  }
> = {
  zh: {
    createError: "创建代表失败。",
    createdMessage: (name) => `已创建代表 ${name}。`,
    requiredFields: "填写代表名称后即可继续",
    workspaceEyebrow: "工作区目录",
    workspaceTitle: "代表目录",
    workspaceCopy: "创建新代表，或切换到现有代表继续配置和发布。",
    createTitle: "创建代表",
    createCopy: "创建后直接进入设置页，不用在长页面里重新找入口。",
    entryScope: "Owner · 1:N",
    ownerName: "主理人名称",
    ownerNameRequired: "请填写主理人名称",
    representativeName: "代表名称",
    representativeNameRequired: "请填写代表名称",
    representativePlaceholder: "Lin 的网页 AI 接待代表",
    tagline: "Tagline",
    taglinePlaceholder: "用公开知识回答问题、筛选合作线索、收集需求，并在需要时转真人。",
    slugHint: "留空时会根据代表名称自动生成。",
    creating: "创建中...",
    createAction: "创建并打开设置",
    createNextStep: "创建后直接进入五步配置，不会立即公开。",
    publishedTitle: "全部对外代理",
    publishedCopy: "草稿和已发布代表都在这里管理；未发布代表不会出现在公开页。",
    publishedVersion: (version) => `已发布 v${version}`,
    unpublished: "未发布",
    emptyTitle: "还没有对外代理",
    emptyCopy: "在上方填写代表名称并创建。创建后会直接进入五步配置流程。",
    repCount: (count) => `${count} 个代表`,
    currentWorkspace: "当前工作区",
    openWorkspace: "打开工作区",
    publicPage: "公开页",
    publishFirst: "发布后开放公开页",
  },
  en: {
    createError: "Failed to create representative.",
    createdMessage: (name) => `Representative ${name} created.`,
    requiredFields: "Add a representative name to continue.",
    workspaceEyebrow: "Workspace directory",
    workspaceTitle: "Representative directory",
    workspaceCopy: "Create a representative or return to an existing one to configure and publish it.",
    createTitle: "Create representative",
    createCopy: "Create one and jump straight into settings instead of searching through a long page.",
    entryScope: "Owner · 1:N",
    ownerName: "Creator name",
    ownerNameRequired: "Please fill creator name.",
    representativeName: "Representative name",
    representativeNameRequired: "Please fill representative name.",
    representativePlaceholder: "Lin's web AI front desk",
    tagline: "Tagline",
    taglinePlaceholder: "Answers public questions, qualifies leads, collects demand, and hands off when needed.",
    slugHint: "Leave blank to generate it from the representative name.",
    creating: "Creating...",
    createAction: "Create and open settings",
    createNextStep: "Creation opens the five-step draft setup. Nothing goes public yet.",
    publishedTitle: "All representatives",
    publishedCopy: "Manage drafts and published representatives here. Drafts stay off public pages.",
    publishedVersion: (version) => `Published v${version}`,
    unpublished: "Unpublished",
    emptyTitle: "No representatives yet",
    emptyCopy: "Name the first representative above. Creation opens the five-step setup flow immediately.",
    repCount: (count) => `${count} reps`,
    currentWorkspace: "Current workspace",
    openWorkspace: "Open workspace",
    publicPage: "Public page",
    publishFirst: "Publish to open public page",
  },
};
