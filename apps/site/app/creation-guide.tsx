"use client";

import { useState } from "react";
import { SiteCreationLink } from "./site-session";
import { copyFor, type MarketingLocale } from "./marketing-copy";

export function CreationGuide({
  locale,
  setupHref,
  representativesHref,
}: {
  locale: MarketingLocale;
  setupHref: string;
  representativesHref: string;
}) {
  const t = copyFor(locale);
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState(0);
  const [tips, setTips] = useState(true);
  const [human, setHuman] = useState(true);
  const steps = [
    [
      t("基本信息", "Identity"),
      t(
        "定义名称、擅长领域、能力与说话风格。",
        "Define a name, expertise, capabilities, and voice.",
      ),
    ],
    [
      t("知识库", "Knowledge"),
      t(
        "上传文件，让对外代理了解你的资料。",
        "Add files to ground your representative in your knowledge.",
      ),
    ],
    [
      t("价格", "Pricing"),
      t(
        "设置套餐、打赏与人工接管权益。",
        "Set plans, tips, and human support entitlements.",
      ),
    ],
    [
      t("对外发布", "Publish"),
      t(
        "确认配置，发布并分享服务入口。",
        "Review, publish, and share your service.",
      ),
    ],
  ];
  const styles = [
    [
      t("专业稳重", "Professional"),
      t(
        "建议先明确目标客户与核心优势。你目前服务哪类客户，主要通过什么渠道获客？",
        "Start by defining your target customers and strengths. Who do you serve, and how do you reach them?",
      ),
    ],
    [
      t("简洁直接", "Direct"),
      t(
        "先确定目标客户。你们提供什么服务，目前谁买得最多？",
        "Define your target customer first. What do you offer, and who buys it most?",
      ),
    ],
    [
      t("亲切自然", "Warm"),
      t(
        "可以，我们一起捋一捋。现在找你的客户，大多是怎么认识你的？",
        "Let’s work through it together. How do most of your current customers find you?",
      ),
    ],
    [
      t("耐心引导", "Patient"),
      t(
        "我们可以一步步来。先聊聊现有客户：他们通常为什么选择你，是价格、专业能力，还是其他原因？",
        "Let’s take it step by step. Why do your customers choose you: price, expertise, or something else?",
      ),
    ],
    [
      t("幽默风趣", "Playful"),
      t(
        "先给拓客装个“导航”。你现在最受哪类客户欢迎？我们先从他们的共同点找方向。",
        "Let’s give your outreach a compass. Which customers like you most? Their shared traits can point the way.",
      ),
    ],
  ];
  const priceSummary = `${tips ? t("已开启打赏", "Tips enabled") : t("未开启打赏", "Tips disabled")} · ${human ? t("人工服务按套餐权益提供", "Human support follows plan terms") : t("仅提供对外代理服务", "AI service only")}`;
  return (
    <section className="create-section" id="create">
      <div className="section-wrap create-layout">
        <div>
          <div className="section-heading">
            <p className="eyebrow">{t("03 / 创建指南", "03 / CREATE YOURS")}</p>
            <h2>{t("创建你的对外代理", "Create your representative")}</h2>
            <p>
              {t(
                "定义个性，添加知识，设置价格，再把服务分享出去。",
                "Define a personality, add knowledge, set pricing, and share your services.",
              )}
            </p>
          </div>
          <div
            className="creation-steps"
            role="group"
            aria-label={t("选择创建步骤", "Explore creation steps")}
          >
            {steps.map(([label, description], index) => (
              <button
                key={label}
                className={`creation-step${step === index ? " active" : ""}`}
                aria-pressed={step === index}
                onClick={() => setStep(index)}
              >
                <span>0{index + 1}</span>
                <div>
                  <strong>{label}</strong>
                  <p>{description}</p>
                </div>
              </button>
            ))}
          </div>
          <SiteCreationLink
            href={setupHref}
            signedInHref={representativesHref}
            locale={locale}
          >
            {t("开始创建我的对外代理", "Create my representative")}
          </SiteCreationLink>
        </div>
        <div className="config-window">
          <div className="window-bar">
            <span className="window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{t("对外代理配置", "Representative configuration")}</span>
            <small>{t("交互示意", "Demo")}</small>
          </div>
          <div
            className="config-progress"
            role="group"
            aria-label={t("配置预览步骤", "Configuration preview steps")}
          >
            {steps.map(([label], index) => (
              <button
                key={label}
                className={step === index ? "active" : ""}
                aria-pressed={step === index}
                onClick={() => setStep(index)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="config-inner">
            {step === 0 && (
              <>
                <h3>
                  {t(
                    "让它有名字，也有个性",
                    "Give it a name and a personality",
                  )}
                </h3>
                <div className="display-field">
                  <span>{t("对外代理名称", "Representative name")}</span>
                  <div className="display-value">
                    {t("Lin 的对外代理", "Lin’s representative")}
                  </div>
                </div>
                <div className="display-field">
                  <span>{t("擅长领域", "Expertise")}</span>
                  <div className="creation-domains">
                    {[
                      t("创业经营", "Business"),
                      t("产品策略", "Product strategy"),
                      t("市场增长", "Growth"),
                    ].map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                </div>
                <div className="display-field">
                  <span>{t("能够做什么", "Capabilities")}</span>
                  <div className="display-value multi">
                    {t(
                      "解答业务问题、梳理增长方向，把想法整理成可执行的行动清单。",
                      "Answer business questions, explore growth, and turn ideas into actionable checklists.",
                    )}
                  </div>
                </div>
                <div className="display-field creation-style-field">
                  <span>{t("说话风格", "Voice")}</span>
                  <div
                    className="creation-style-options"
                    role="group"
                    aria-label={t(
                      "体验对外代理说话风格",
                      "Try a representative voice",
                    )}
                  >
                    {styles.map(([label], index) => (
                      <button
                        key={label}
                        aria-pressed={style === index}
                        onClick={() => setStyle(index)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="creation-style-sample">
                    <span>
                      {t(
                        "访客提问：我想拓展新客户，应该先做什么？",
                        "Visitor: I want to reach new customers. Where should I start?",
                      )}
                    </span>
                    <p aria-live="polite">{styles[style]![1]}</p>
                  </div>
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <h3>
                  {t(
                    "上传资料，让回答有据可依",
                    "Ground answers in your knowledge",
                  )}
                </h3>
                <div
                  className="creation-upload-example"
                  role="img"
                  aria-label={t(
                    "文件上传区域示意",
                    "Illustration of a file upload area",
                  )}
                >
                  <span className="creation-upload-icon" aria-hidden="true">
                    ↑
                  </span>
                  <strong>{t("上传文件", "Upload files")}</strong>
                  <p>
                    {t(
                      "产品介绍、服务说明、案例资料",
                      "Product guides, service details, and case studies",
                    )}
                  </p>
                </div>
                <div className="creation-files-heading">
                  <span>{t("示例文件", "Example files")}</span>
                  <span>{t("2 份资料", "2 files")}</span>
                </div>
                {[
                  [
                    "PDF",
                    t("产品与服务介绍.pdf", "Products and services.pdf"),
                    t("服务内容与适用场景", "Services and use cases"),
                  ],
                  [
                    "DOCX",
                    t("合作案例.docx", "Case studies.docx"),
                    t("项目经验与常见问题", "Project experience and FAQs"),
                  ],
                ].map(([type, title, description]) => (
                  <div className="document-row" key={type}>
                    <span className="file-icon">{type}</span>
                    <div>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </div>
                  </div>
                ))}
                <p className="creation-inline-note">
                  {t(
                    "对外代理会结合这些资料回答问题。此处为示例，不会上传文件。",
                    "Your representative uses these sources to answer. This preview does not upload files.",
                  )}
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <h3>
                  {t("按你的服务方式定价", "Price your services your way")}
                </h3>
                <div className="creation-pack-heading">
                  <span>{t("服务套餐", "Service plans")}</span>
                  <span>{t("示例 · 可自行修改", "Example plans")}</span>
                </div>
                <div className="creation-packs">
                  {[
                    [t("基础服务包", "Basic"), "5", "500"],
                    [t("进阶服务包", "Plus"), "19", "2,000"],
                    [t("专业服务包", "Professional"), "49", "5,000"],
                  ].map(([name, price, credits]) => (
                    <div className="creation-pack" key={name}>
                      <div>
                        <strong>{name}</strong>
                        <span>
                          {credits} {t("服务额度", "service credits")}
                        </span>
                      </div>
                      <b>¥{price}</b>
                    </div>
                  ))}
                </div>
                <div className="creation-option-row">
                  <div>
                    <strong>{t("支持打赏", "Accept tips")}</strong>
                    <span>
                      {t(
                        "访客可自愿表达支持",
                        "Let visitors show their support",
                      )}
                    </span>
                  </div>
                  <button
                    role="switch"
                    className="creation-toggle"
                    aria-label={t("支持打赏", "Accept tips")}
                    aria-checked={tips}
                    onClick={() => setTips(!tips)}
                  >
                    <span />
                  </button>
                </div>
                <div className="creation-option-row">
                  <div>
                    <strong>{t("支持人工接管", "Offer human support")}</strong>
                    <span>
                      {t(
                        "按套餐设置次数、优先级与有效期",
                        "Set limits, priority, and validity per plan",
                      )}
                    </span>
                  </div>
                  <button
                    role="switch"
                    className="creation-toggle"
                    aria-label={t("支持人工接管", "Offer human support")}
                    aria-checked={human}
                    onClick={() => setHuman(!human)}
                  >
                    <span />
                  </button>
                </div>
                <p className="creation-inline-note" role="status">
                  {priceSummary}
                </p>
              </>
            )}
            {step === 3 && (
              <>
                <h3>
                  {t("准备好，就对外发布", "Ready to share with the world")}
                </h3>
                <div className="creation-publish-person">
                  <img src="/marketing/ceo.jpg" alt="" width="48" height="48" />
                  <div>
                    <strong>
                      {t("Lin 的对外代理", "Lin’s representative")}
                    </strong>
                    <span>
                      {t(
                        "创业经营 · 产品策略 · 市场增长",
                        "Business · Product strategy · Growth",
                      )}
                    </span>
                  </div>
                  <span className="creation-ready">{t("待发布", "Draft")}</span>
                </div>
                <dl className="creation-publish-checks">
                  <div>
                    <dt>✓ {steps[0]![0]}</dt>
                    <dd>
                      {t("已定义身份与能力", "Identity and capabilities set")} ·{" "}
                      {styles[style]![0]}
                    </dd>
                  </div>
                  <div>
                    <dt>✓ {steps[1]![0]}</dt>
                    <dd>{t("2 份示例文件", "2 example files")}</dd>
                  </div>
                  <div>
                    <dt>✓ {t("价格与权益", "Pricing & entitlements")}</dt>
                    <dd>
                      {t("3 档套餐", "3 service plans")} · {priceSummary}
                    </dd>
                  </div>
                </dl>
                <div className="creation-sharing">
                  <strong>
                    {t(
                      "发布后，分享你的专属链接",
                      "Share your personal link after publishing",
                    )}
                  </strong>
                  <p>
                    {t(
                      "放在官网、社交主页，或直接发给需要你服务的人。",
                      "Add it to your website or social profile, or send it to someone who needs your expertise.",
                    )}
                  </p>
                  <div className="creation-domains">
                    {[
                      t("官网", "Website"),
                      t("社交主页", "Social profile"),
                      t("直接分享", "Direct link"),
                    ].map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                </div>
                <SiteCreationLink
                  className="button creation-publish-link"
                  href={setupHref}
                  signedInHref={representativesHref}
                  locale={locale}
                >
                  {t("创建我的对外代理", "Create my representative")} ↗
                </SiteCreationLink>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
