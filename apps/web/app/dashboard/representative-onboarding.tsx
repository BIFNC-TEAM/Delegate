"use client";
import { useEffect, useRef, useState } from "react";
import {
  expressionStyles,
  onboardingDirections,
  onboardingStepError,
  suggestedServices,
  workFields,
  type OnboardingDraft,
} from "@delegate/domain/representative-onboarding";
import {
  RepresentativeAvatar,
  RepresentativeAvatarEditor,
} from "./representative-avatar-editor";

const steps = ["工作领域", "起个名字", "服务内容", "表达风格"];
const titles = [
  "你主要在哪个领域工作？",
  "给你的对外代理起个名字",
  "你希望它提供哪些服务？",
  "你希望它怎么说话？",
];
export function RepresentativeOnboarding({
  draft,
  ownerName,
  locale,
  onChange,
  onExit,
  onCreated,
}: {
  draft: OnboardingDraft;
  ownerName: string;
  locale: string;
  onChange: (draft: OnboardingDraft) => void;
  onExit: () => void;
  onCreated: (slug: string) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    text: string;
    truncated: boolean;
  } | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  useEffect(() => {
    heading.current?.focus();
  }, [draft.step]);
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
    },
    [],
  );
  function change(patch: Partial<OnboardingDraft>) {
    setError("");
    if (
      patch.services !== undefined ||
      patch.fields !== undefined ||
      patch.customField !== undefined
    ) {
      generation.current++;
      request.current?.abort();
      setSuggesting(false);
      setSuggestion(null);
    }
    onChange({ ...latestDraft.current, ...patch });
  }
  async function suggest() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++generation.current;
    setSuggesting(true);
    setError("");
    setSuggestion(null);
    try {
      const response = await fetch(
        "/api/dashboard/service-content-suggestions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workFields: onboardingDirections(draft),
            serviceContent: draft.services,
            language: locale === "en" ? "en" : "zh",
          }),
          signal: controller.signal,
        },
      );
      const data = await response.json();
      if (id !== generation.current) return;
      if (
        !response.ok ||
        data.status !== "success" ||
        !data.serviceContent?.trim()
      )
        throw new Error(
          response.status === 401
            ? "请登录后使用 AI 帮写，已填写内容会保留。"
            : data.message || data.error || "暂时未生成建议，请稍后重试。",
        );
      setSuggestion({
        text: data.serviceContent,
        truncated: Boolean(data.truncated),
      });
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "生成失败，请重试。");
    } finally {
      if (id === generation.current) setSuggesting(false);
    }
  }
  async function next() {
    const message = onboardingStepError(draft, draft.step);
    if (message) {
      setError(message);
      return;
    }
    if (draft.step < 3) {
      change({ step: draft.step + 1 });
      return;
    }
    for (let step = 0; step < 4; step++) {
      const invalid = onboardingStepError(draft, step);
      if (invalid) {
        onChange({ ...draft, step });
        setError(invalid);
        return;
      }
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/dashboard/representatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerName,
          representativeName: draft.name,
          onboarding: draft,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建失败，请重试。");
      onCreated(data.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败，请重试。");
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }
  return (
    <section className="d-onboarding">
      <header className="d-onboard-progress">
        <ol aria-label="创建引导进度">
          {steps.map((step, i) => (
            <li
              key={step}
              aria-current={i === draft.step ? "step" : undefined}
              className={
                i === draft.step ? "current" : i < draft.step ? "done" : ""
              }
            >
              <span>{i < draft.step ? "✓" : i + 1}</span>
              <small>{step}</small>
            </li>
          ))}
        </ol>
      </header>
      <div className="d-onboard-layout">
        <form
          className="d-onboard-form"
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
        >
          <div className="d-overline">第 {draft.step + 1} / 4 步</div>
          <h2 ref={heading} tabIndex={-1}>
            {titles[draft.step]}
          </h2>
          <p className="d-onboard-subtitle">
            {
              [
                "可多选，也可以补充自己的工作方向。",
                "访客会通过这个名字认识它，之后也可以修改。",
                "写下你擅长的事情，或从与你的领域相关的建议开始。",
                "选择最适合你的服务方式，生成后还可以微调。",
              ][draft.step]
            }
          </p>
          <fieldset disabled={busy} className="d-onboard-fields">
            {draft.step === 0 ? (
              <>
                <div
                  className="d-onboard-tags"
                  role="group"
                  aria-label="工作领域"
                >
                  {workFields.map((field) => (
                    <button
                      key={field}
                      className={
                        draft.fields.includes(field)
                          ? "d-choice selected"
                          : "d-choice"
                      }
                      type="button"
                      aria-pressed={draft.fields.includes(field)}
                      onClick={() =>
                        change({
                          fields: draft.fields.includes(field)
                            ? draft.fields.filter((f) => f !== field)
                            : [...draft.fields, field],
                        })
                      }
                    >
                      {field}
                      {draft.fields.includes(field) ? " ✓" : ""}
                    </button>
                  ))}
                </div>
                <label className="d-field">
                  <span className="d-label">
                    补充工作方向
                    {draft.fields.includes("其他") ? "" : "（选填）"}
                  </span>
                  <input
                    maxLength={80}
                    value={draft.customField}
                    onChange={(e) => change({ customField: e.target.value })}
                    placeholder="例如：面向中小企业的品牌咨询"
                  />
                </label>
              </>
            ) : null}
            {draft.step === 1 ? (
              <>
                <RepresentativeAvatarEditor
                  value={draft.avatarUrl}
                  name={draft.name}
                  onChange={(avatarUrl) => change({ avatarUrl })}
                  onBusyChange={setAvatarBusy}
                />
                <label className="d-field">
                  <span className="d-label">对外代理名称</span>
                  <input
                    maxLength={60}
                    value={draft.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <p className="d-help">
                  你可以用自己的名字，也可以为它取一个独特的名字。
                </p>
              </>
            ) : null}
            {draft.step === 2 ? (
              <>
                <div className="d-between d-service-label">
                  <label className="d-label" htmlFor="rep-onboarding-services">
                    服务内容
                  </label>
                  <button
                    type="button"
                    className="d-button"
                    disabled={suggesting}
                    onClick={() => void suggest()}
                  >
                    {suggesting ? "正在生成建议…" : "✧ AI 帮你写"}
                  </button>
                </div>
                <textarea
                  id="rep-onboarding-services"
                  rows={5}
                  maxLength={500}
                  value={draft.services}
                  onChange={(e) => change({ services: e.target.value })}
                  placeholder="例如：介绍我的产品咨询服务，梳理客户需求，整理产品改进建议。"
                />
                <p className="d-help">
                  根据你选择的领域，或许可以从这些内容开始：
                </p>
                <div className="d-service-suggestions">
                  {suggestedServices(draft.fields).map((option) => (
                    <button
                      type="button"
                      className="d-button d-ghost"
                      key={option}
                      onClick={() => {
                        const text = draft.services
                          ? `${draft.services.replace(/[。；;\s]+$/u, "")}；${option}`
                          : option;
                        if (Array.from(text).length > 500)
                          setError("服务内容最多 500 字，请精简后添加。");
                        else change({ services: text });
                      }}
                    >
                      + {option}
                    </button>
                  ))}
                </div>
                {suggestion ? (
                  <div className="d-suggestion" role="status">
                    <div className="d-between d-service-label">
                      <strong>为你准备的服务建议</strong>
                      <button type="button" onClick={() => setSuggestion(null)}>
                        收起
                      </button>
                    </div>
                    <p>{suggestion.text}</p>
                    {suggestion.truncated ? (
                      <p>建议已截取至 500 字，请核对后采用。</p>
                    ) : null}
                    <button
                      type="button"
                      className="d-button"
                      onClick={() => change({ services: suggestion.text })}
                    >
                      {draft.services.trim()
                        ? "用这段替换当前内容"
                        : "采用这段建议"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            {draft.step === 3 ? (
              <>
                <div
                  className="d-tone-options"
                  role="group"
                  aria-label="表达风格"
                >
                  {expressionStyles.map((tone, i) => (
                    <button
                      type="button"
                      className={
                        i === draft.tone
                          ? "d-tone-option selected"
                          : "d-tone-option"
                      }
                      aria-pressed={i === draft.tone}
                      key={tone.name}
                      onClick={() => change({ tone: i })}
                    >
                      <span>
                        <strong>{tone.name}</strong>
                        <small>{tone.description}</small>
                      </span>
                      <span className="d-radio-dot" aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <div className="d-tone-sample">
                  <RepresentativeAvatar
                    url={draft.avatarUrl}
                    name={draft.name}
                  />
                  <div>
                    <small>{draft.name} · 语气示例</small>
                    <p>{expressionStyles[draft.tone]!.sample}</p>
                  </div>
                </div>
              </>
            ) : null}
          </fieldset>
          {error ? (
            <p className="d-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="d-onboard-footer">
            <button
              className="d-button"
              disabled={busy || avatarBusy}
              type="button"
              onClick={() =>
                draft.step ? change({ step: draft.step - 1 }) : onExit()
              }
            >
              {draft.step ? "上一步" : "返回列表"}
            </button>
            <span>答案可随时返回修改</span>
            <button
              className="d-button d-primary"
              disabled={busy || avatarBusy}
              type="submit"
            >
              {busy
                ? "正在生成…"
                : draft.step === 3
                  ? "生成基本信息 →"
                  : "下一步 →"}
            </button>
          </footer>
        </form>
        <aside className="d-onboard-aside">
          <RepresentativeAvatar
            url={draft.avatarUrl}
            name={draft.name}
            className="d-onboard-preview-avatar"
          />
          <div className="d-overline">属于你的对外代理</div>
          <h3>{draft.name || "从一个名字开始"}</h3>
          <p>
            把你擅长的事，
            <br />
            变成它能提供的服务。
          </p>
          <dl>
            <div>
              <dt>创建者</dt>
              <dd>{ownerName}</dd>
            </div>
            <div>
              <dt>工作领域</dt>
              <dd>{onboardingDirections(draft).join(" · ") || "等待选择"}</dd>
            </div>
            <div>
              <dt>表达风格</dt>
              <dd>
                {draft.step === 3
                  ? expressionStyles[draft.tone]!.name
                  : "稍后选择"}
              </dd>
            </div>
          </dl>
          <small>
            回答完成后，将自动整理为
            <br />
            可编辑的基本信息。
          </small>
        </aside>
      </div>
    </section>
  );
}
