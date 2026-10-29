"use client";

import type { AgentBehavior } from "@delegate/domain";
import type { Locale } from "@delegate/web-ui";

export function AgentBehaviorFields({ value, onChange, locale }: {
  value?: AgentBehavior | undefined; onChange(value: AgentBehavior): void; locale: Locale;
}) {
  const zh = locale === "zh";
  return <div className="field-stack field-span-full">
    <strong>{zh ? "回答规则（草稿）" : "Answer policy (draft)"}</strong>
    <p className="field-hint">{zh
      ? "身份与语气控制如何表达；下列选项分别控制回答范围、知识依据和承诺边界。保存后需发布才会用于新版本，在途任务仍使用固定版本。工具权限、资料访问和审批单独控制。"
      : "Identity and tone control expression. These independent options control answer scope, evidence and commitments. Save and publish to apply to a new version; in-flight tasks keep their pinned version. Tool access, data grants and approval are separate."}</p>
    {!value ? <>
      <p>{zh ? "这个旧代表尚未单独配置，已发布版本仍沿用旧规则。新配置默认专业问题先查授权资料；保存并发布后生效。" : "This legacy representative has no separate policy; published behavior is unchanged. New configurations default to authorized materials first for specialty questions. Save and publish to apply."}</p>
      <div><button className="button-secondary" type="button" onClick={() => onChange({ version: 1, answerScope: "owner_and_domain", knowledgePolicy: "domain_first", commitmentPolicy: "information_only" })}>
        {zh ? "配置回答规则" : "Configure answer policy"}
      </button></div>
    </> : <div className="setup-grid">
      <label className="field-stack"><span>{zh ? "回答范围" : "Answer scope"}</span>
        <select className="text-input" value={value.answerScope} onChange={event => onChange({ ...value, answerScope: event.target.value as AgentBehavior["answerScope"] })}>
          <option value="owner_and_domain">{zh ? "所有者及专业领域" : "Owner and specialty"}</option>
          <option value="open_public">{zh ? "允许通用问答和公开查询" : "General answers and public lookups"}</option>
        </select>
        <small className="field-hint">{zh ? "通用回答不代表所有者观点；超出范围时说明边界，不换题。" : "General answers are not owner views. Explain a scope boundary without changing the topic."}</small>
      </label>
      <label className="field-stack"><span>{zh ? "专业知识依据" : "Specialty evidence"}</span>
        <select className="text-input" value={value.knowledgePolicy} onChange={event => onChange({ ...value, knowledgePolicy: event.target.value as AgentBehavior["knowledgePolicy"] })}>
          <option value="owner_facts">{zh ? "通用解释可直答，所有者事实需资料" : "General explanations allowed; owner facts need evidence"}</option>
          <option value="domain_first">{zh ? "先查授权资料，未命中可标注通用补充（默认）" : "Materials first; labeled general supplement after no match (default)"}</option>
          <option value="domain_only">{zh ? "专业回答仅依据授权资料" : "Specialty answers use authorized materials only"}</option>
        </select>
        <small className="field-hint">{zh ? "无权限或检索失败不算未命中。所有者政策、价格和承诺始终需要授权依据。" : "Denied/failed retrieval is not a no-match. Owner policies, prices and terms always require authorized evidence."}</small>
      </label>
      <label className="field-stack"><span>{zh ? "所有者承诺边界" : "Owner commitments"}</span>
        <select className="text-input" value={value.commitmentPolicy} onChange={event => onChange({ ...value, commitmentPolicy: event.target.value as AgentBehavior["commitmentPolicy"] })}>
          <option value="information_only">{zh ? "只提供信息，不代为承诺" : "Information only; no undertakings"}</option>
          <option value="authorized_terms">{zh ? "仅重申有授权依据的既有条款" : "Restate evidenced existing terms only"}</option>
        </select>
        <small className="field-hint">{zh ? "两种模式都不能新增或扩大承诺，也不会授予退款、下单等行动权限。" : "Neither mode creates or extends commitments, or grants refund/order permissions."}</small>
      </label>
    </div>}
  </div>;
}
