export type GovernedMemoryDisclosure = {
  enabled: boolean;
  contactMemoryEnabled: boolean;
  representativeExperienceEnabled: boolean;
  automaticExtractionEnabled: boolean;
  retentionDays: number | null;
  expiryAction: "ARCHIVE" | "DELETE" | null;
  policyRevision: number | null;
  fingerprint: string;
};

export function getGovernedContextDisclosure(
  locale: "zh" | "en",
  policy: GovernedMemoryDisclosure,
): string {
  const retentionDays = policy.retentionDays;
  if (
    (policy.enabled || policy.automaticExtractionEnabled)
    && (retentionDays === null || policy.expiryAction === null)
  ) {
    // The server normally prevents this state. Keep the public boundary
    // conservative if an incomplete policy ever reaches the page.
    return getGovernedContextDisclosure(locale, {
      ...policy,
      enabled: false,
      automaticExtractionEnabled: false,
    });
  }

  if (!policy.enabled && policy.automaticExtractionEnabled) {
    const expiryZh = policy.expiryAction === "ARCHIVE"
      ? "到期后归档并停止召回"
      : "到期后停止召回并进入可审计的异步清理";
    const expiryEn = policy.expiryAction === "ARCHIVE"
      ? "then it is archived and cannot be recalled"
      : "then recall remains blocked and auditable asynchronous cleanup begins";
    return locale === "zh"
      ? `跨会话长期记忆召回当前未启用，但 Web 联系人记忆候选自动提取已启用。本次消息只可能生成联系人偏好、目标、约束与必要背景候选，并严格限定在当前联系人、当前数字代表和 Web 渠道。候选必须先通过安全检查和所需审核，原始聊天全文不会直接写入长期记忆；代表经验不会从 Web 消息自动提取。原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆。获准内容保留 ${retentionDays} 天，${expiryZh}；在召回关闭期间不会用于 Web 回答。你可以在聊天中提出查看、纠正或删除请求，也可以联系 Owner 处理。`
      : `Cross-conversation memory recall is currently disabled, but automatic Web contact-memory candidate extraction is enabled. This message may create candidates only for contact preferences, goals, constraints, and necessary context, strictly scoped to this contact, this representative, and the Web channel. Candidates must pass safety checks and required review, and the raw transcript is never written directly to long-term memory; representative experience is never extracted automatically from Web messages. Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly. Approved content is retained for ${retentionDays} days; ${expiryEn}; while recall is off it is not used in Web replies. You can ask in chat to view, correct, or delete memory, or contact the Owner for help.`;
  }

  if (!policy.enabled) {
    return locale === "zh"
      ? "受治理长期记忆当前未启用：本次 Web 对话不会创建或调用跨会话的联系人记忆或代表经验，因此没有因本次对话新增的长期记忆保留期限。回答仍可使用已发布的公开知识。原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆。你可以在聊天中提出查看、纠正或删除已有记忆的请求，也可以联系 Owner 处理。"
      : "Governed long-term memory is currently disabled: this Web conversation will not create or recall cross-conversation contact memory or representative experience, so no new long-term-memory retention period applies to this chat. Replies may still use published public knowledge. Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly. You can ask in chat to view, correct, or delete existing memory, or contact the Owner for help.";
  }

  if (locale === "zh") {
    const enabledKinds = [
      policy.contactMemoryEnabled
        ? "经安全检查和审核的联系人偏好、目标、约束与必要背景"
        : null,
      policy.representativeExperienceEnabled
        ? "去标识化且经人工审核的代表经验"
        : null,
    ].filter((value): value is string => value !== null).join("；");
    const scopes = [
      policy.contactMemoryEnabled
        ? "联系人记忆严格限定在当前联系人、当前数字代表和 Web 渠道，其他联系人、代表或渠道不可见"
        : null,
      policy.representativeExperienceEnabled
        ? "代表经验只服务当前数字代表，可面向其访客使用，但不包含任何联系人身份或个人事实"
        : null,
    ].filter((value): value is string => value !== null).join("；");
    const extraction = policy.automaticExtractionEnabled
      ? "Web 消息只会先生成联系人记忆候选，必须通过安全检查和所需审核后才可能生效；代表经验不会自动提取，原始聊天全文不会直接写入长期记忆"
      : "本次 Web 对话不会自动提取新的长期记忆；仅已有且通过审核的安全摘要可用于回答";
    const expiry = policy.expiryAction === "ARCHIVE"
      ? "到期后归档并停止召回"
      : "到期后立即停止召回并进入可审计的异步清理";
    return `受治理长期记忆已启用。可使用的记忆类型包括：${enabledKinds}。作用范围：${scopes}。${extraction}。原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆，也不会读取 Owner 的私有工作区、文件或账号。经批准的记忆保留 ${retentionDays} 天，${expiry}。你可以在聊天中提出查看、纠正或删除请求，也可以联系 Owner 处理；停用或删除后将停止用于后续回答。`;
  }

  const enabledKinds = [
    policy.contactMemoryEnabled
      ? "safety-checked and reviewed contact preferences, goals, constraints, and necessary context"
      : null,
    policy.representativeExperienceEnabled
      ? "deidentified representative experience approved by a human reviewer"
      : null,
  ].filter((value): value is string => value !== null).join("; ");
  const scopes = [
    policy.contactMemoryEnabled
      ? "contact memory is restricted to this contact, this representative, and the Web channel; no other contact, representative, or channel can see it"
      : null,
    policy.representativeExperienceEnabled
      ? "representative experience serves only this representative across visitors and contains no contact identity or personal facts"
      : null,
  ].filter((value): value is string => value !== null).join("; ");
  const extraction = policy.automaticExtractionEnabled
    ? "Web messages can only create contact-memory candidates first; they must pass safety checks and required review before becoming active, representative experience is never extracted automatically, and the raw transcript is never written directly to long-term memory"
    : "this Web conversation does not automatically extract new long-term memory; only existing, approved safe summaries may support a reply";
  const expiry = policy.expiryAction === "ARCHIVE"
    ? "then it is archived and no longer recalled"
    : "then recall stops immediately and auditable asynchronous cleanup begins";
  return `Governed long-term memory is enabled. Eligible memory types are: ${enabledKinds}. Scope: ${scopes}. ${extraction}. Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly, and the Owner's private workspace, files, and accounts are never accessed. Approved memory is retained for ${retentionDays} days; ${expiry}. You can ask in chat to view, correct, or delete memory, or contact the Owner for help; disabled or deleted memory is no longer used in later replies.`;
}
