"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState, useTransition } from "react";
import { buildLocalizedHref, pickCopy, type Locale } from "@delegate/web-ui";

type RepresentativeDirectoryItem = {
  id: string;
  slug: string;
  ownerName: string;
  name: string;
  tagline: string;
  updatedAt: string;
};

type CreateRepresentativeFieldErrors = Partial<{
  ownerName: string;
  representativeName: string;
}>;

export function DashboardRepresentativeDirectory({
  activeSlug,
  activeView,
  initialRepresentatives,
  locale,
  representativeBaseUrl,
}: {
  activeSlug: string;
  activeView: "overview" | "setup" | "skills" | "compute" | "wallet" | "memory" | "training";
  initialRepresentatives: RepresentativeDirectoryItem[];
  locale: Locale;
  representativeBaseUrl: string;
}) {
  const router = useRouter();
  const t = pickCopy(locale, copy);
  const [representatives, setRepresentatives] = useState(initialRepresentatives);
  const [ownerName, setOwnerName] = useState("");
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
          },
          ...representatives.filter((item) => item.slug !== created.slug),
        ];

        setRepresentatives(nextList);
        setOwnerName("");
        setRepresentativeName("");
        setSlug("");
        setTagline("");
        setMessage(t.createdMessage(created.name));
        router.push(`/dashboard?rep=${created.slug}&view=setup&lang=${locale}`);
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
    <section className="dashboard-rail-stack">
      <div className="dashboard-rail-header">
        <div>
          <p className="eyebrow">{t.workspaceEyebrow}</p>
          <h2>{t.workspaceTitle}</h2>
        </div>
        <p className="section-copy">{t.workspaceCopy}</p>
      </div>

      {message ? <div className="status-banner status-success">{message}</div> : null}
      {error ? <div className="status-banner status-error">{error}</div> : null}

      <article className="dashboard-rail-card">
        <div className="setup-section-header">
          <div>
            <h3>{t.createTitle}</h3>
            <p>{t.createCopy}</p>
          </div>
          <span className="chip">{t.entryScope}</span>
        </div>

        <form className="setup-stack" onSubmit={handleSubmit}>
          <label className="field-stack">
            <span>{t.ownerName}</span>
            <input
              aria-describedby={fieldErrors.ownerName ? "owner-name-error" : undefined}
              aria-invalid={Boolean(fieldErrors.ownerName)}
              className="text-input"
              onChange={(event) => {
                setOwnerName(event.target.value);
                clearFieldError("ownerName");
              }}
              placeholder={locale === "zh" ? "Lin" : "Lin"}
              value={ownerName}
            />
            {fieldErrors.ownerName ? (
              <span className="field-error" id="owner-name-error">
                {fieldErrors.ownerName}
              </span>
            ) : null}
          </label>

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
          </label>

          <label className="field-stack">
            <span>{t.tagline}</span>
            <input
              className="text-input"
              onChange={(event) => setTagline(event.target.value)}
              placeholder={t.taglinePlaceholder}
              value={tagline}
            />
          </label>

          <div className="button-row button-row-stretch">
            <button className="button-primary button-block" disabled={isCreateDisabled} type="submit">
              {isPending ? t.creating : t.createAction}
            </button>
          </div>
          {isCreateDisabled && !isPending ? <p className="footer-note">{t.requiredFields}</p> : null}
        </form>
      </article>

      <article className="dashboard-rail-card">
        <div className="setup-section-header">
          <div>
            <h3>{t.publishedTitle}</h3>
            <p>{t.publishedCopy}</p>
          </div>
          <span className="chip">{t.repCount(representatives.length)}</span>
        </div>

        <div className="directory-list">
          {representatives.map((representative) => {
            const isActive = representative.slug === activeSlug;

            return (
              <article
                className={isActive ? "directory-card directory-card-active" : "directory-card"}
                key={representative.id}
              >
                <div>
                  <p className="panel-title">{representative.ownerName}</p>
                  <h3>{representative.name}</h3>
                  <p>{representative.tagline}</p>
                </div>

                <div className="button-row button-row-stretch">
                  <Link
                    className={isActive ? "button-primary button-block" : "button-secondary button-block"}
                    href={`/dashboard?rep=${representative.slug}&view=${activeView}&lang=${locale}`}
                  >
                    {isActive ? t.currentWorkspace : t.openWorkspace}
                  </Link>
                  <a
                    className="button-secondary button-block"
                    href={buildLocalizedHref(`${representativeBaseUrl}/reps/${representative.slug}`, locale)}
                  >
                    {t.publicPage}
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </article>
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
    creating: string;
    createAction: string;
    publishedTitle: string;
    publishedCopy: string;
    repCount: (count: number) => string;
    currentWorkspace: string;
    openWorkspace: string;
    publicPage: string;
  }
> = {
  zh: {
    createError: "创建代表失败。",
    createdMessage: (name) => `已创建代表 ${name}。`,
    requiredFields: "请填写 owner name / representative name",
    workspaceEyebrow: "工作区目录",
    workspaceTitle: "选择代表与发布入口",
    workspaceCopy: "把代表切换、创建和公开入口固定在左侧，不打断右侧当前任务。",
    createTitle: "创建代表",
    createCopy: "创建后直接进入 setup，不用在超长页面里重新找入口。",
    entryScope: "Web-first",
    ownerName: "Owner name",
    ownerNameRequired: "请填写 owner name",
    representativeName: "Representative name",
    representativeNameRequired: "请填写 representative name",
    representativePlaceholder: "Lin 的网页 AI 接待代表",
    tagline: "Tagline",
    taglinePlaceholder: "用公开知识回答问题、筛选合作线索、收集需求，并在需要时转真人。",
    creating: "创建中...",
    createAction: "创建并打开 setup",
    publishedTitle: "已发布代表",
    publishedCopy: "切换代表时保留当前 tab，不打断当前工作流。",
    repCount: (count) => `${count} 个 reps`,
    currentWorkspace: "当前工作区",
    openWorkspace: "打开工作区",
    publicPage: "公开页",
  },
  en: {
    createError: "Failed to create representative.",
    createdMessage: (name) => `Representative ${name} created.`,
    requiredFields: "Please fill owner name / representative name.",
    workspaceEyebrow: "Workspace directory",
    workspaceTitle: "Choose a representative and its public entry",
    workspaceCopy: "Keep switching, creation, and public links in the left rail so the right pane stays on the current task.",
    createTitle: "Create representative",
    createCopy: "Create one and jump straight into setup instead of searching through a long settings page.",
    entryScope: "Web-first",
    ownerName: "Owner name",
    ownerNameRequired: "Please fill owner name.",
    representativeName: "Representative name",
    representativeNameRequired: "Please fill representative name.",
    representativePlaceholder: "Lin's web AI front desk",
    tagline: "Tagline",
    taglinePlaceholder: "Answers public questions, qualifies leads, collects demand, and hands off when needed.",
    creating: "Creating...",
    createAction: "Create and open setup",
    publishedTitle: "Published representatives",
    publishedCopy: "Switch representatives without losing your current tab or workflow context.",
    repCount: (count) => `${count} reps`,
    currentWorkspace: "Current workspace",
    openWorkspace: "Open workspace",
    publicPage: "Public page",
  },
};
