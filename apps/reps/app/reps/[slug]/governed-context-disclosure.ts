export type GovernedMemoryDisclosure = {
  enabled: boolean;
  shortTermMemoryEnabled: boolean;
  contactMemoryEnabled: boolean;
  contactMemoryCrossChannelEnabled: boolean;
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
    const extractionKindsZh = policy.contactMemoryEnabled
      ? policy.representativeExperienceEnabled
        ? `本次消息可能提取仅限当前联系人的偏好、目标、约束与必要背景${policy.contactMemoryCrossChannelEnabled ? "；登录并验证为同一 Delegate 身份后，跨渠道联系人记忆默认开启，安全摘要可供当前代表在 Web、Matrix 和 Telegram 私聊间使用，你可以随时关闭" : "并限定在当前数字代表和 Web 渠道"}，也可能作为去标识化、多来源聚合的代表经验输入；单条消息或单个联系人不会直接生成代表经验`
        : `本次消息只可能提取联系人偏好、目标、约束与必要背景，${policy.contactMemoryCrossChannelEnabled ? "登录并验证为同一 Delegate 身份后，跨渠道联系人记忆默认开启，安全摘要可供当前代表在 Web、Matrix 和 Telegram 私聊间使用，你可以随时关闭" : "并严格限定在当前联系人、当前数字代表和 Web 渠道"}`
      : "本次消息只可能作为去标识化、多来源聚合的代表经验输入；单条消息或单个联系人不会直接生成代表经验，联系人事实不会进入代表经验";
    const extractionKindsEn = policy.contactMemoryEnabled
      ? policy.representativeExperienceEnabled
        ? `This message may yield contact preferences, goals, constraints, and necessary context scoped only to this contact${policy.contactMemoryCrossChannelEnabled ? "; after sign-in verifies the same Delegate identity, cross-channel Contact Memory defaults on so this representative may use safe summaries across Web, Matrix, and Telegram private chats, and you can turn it off at any time" : ", this representative, and the Web channel"}, and may also contribute to deidentified Representative Experience aggregated across sources; one message or one contact cannot directly create Representative Experience`
        : `This message may extract only contact preferences, goals, constraints, and necessary context${policy.contactMemoryCrossChannelEnabled ? "; after sign-in verifies the same Delegate identity, cross-channel Contact Memory defaults on so this representative may use safe summaries across Web, Matrix, and Telegram private chats, and you can turn it off at any time" : ", strictly scoped to this contact, this representative, and the Web channel"}`
      : "This message may only contribute to deidentified Representative Experience aggregated across sources; one message or one contact cannot directly create Representative Experience, and contact facts do not enter Representative Experience";
    return locale === "zh"
      ? `跨会话长期记忆召回当前未启用，但 Web 长期记忆自动提取已启用。${extractionKindsZh}。低风险结构化内容只有通过自动来源、范围和安全策略后才会生效；不确定或敏感内容会自动阻止，原始聊天全文不会直接写入长期记忆。原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆。生效内容保留 ${retentionDays} 天，${expiryZh}；在召回关闭期间不会用于 Web 回答。聊天内自助查看和纠正尚未提供；发送“删除我的记忆”可立即停止召回并异步清理当前代表与当前 Web 渠道下的联系人记忆。`
      : `Cross-conversation memory recall is currently disabled, but automatic Web long-term memory extraction is enabled. ${extractionKindsEn}. Low-risk structured content becomes active only after automated source, scope, and safety policy checks; uncertain or sensitive content is blocked, and the raw transcript is never written directly to long-term memory. Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly. Active content is retained for ${retentionDays} days; ${expiryEn}; while recall is off it is not used in Web replies. Self-service viewing and correction are not yet available; send “删除我的记忆” to stop recall immediately and asynchronously delete Contact Memory for this representative and Web channel.`;
  }

  if (!policy.enabled) {
    return locale === "zh"
      ? `跨会话长期记忆当前未启用：本次 Web 对话不会创建或调用联系人长期记忆或代表经验。${policy.shortTermMemoryEnabled ? "回答可使用本次会话同一阶段内的近期访客消息作为短期上下文；这些内容不会进入 OpenViking 或自动升级为长期记忆。" : "短期上下文也已关闭，回答只使用当前消息与已发布公开知识。"}原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆。如需清除当前代表与当前 Web 渠道下已存在的联系人记忆，可发送“删除我的记忆”。`
      : `Cross-conversation long-term memory is currently disabled: this Web conversation will not create or recall contact long-term memory or representative experience. ${policy.shortTermMemoryEnabled ? "Replies may use recent visitor messages from the current conversation stage as short-term context; that context is not written to OpenViking or automatically promoted to long-term memory. " : "Short-term context is also disabled, so replies use only the current message and published public knowledge. "}Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly. To clear existing Contact Memory for this representative and Web channel, send “删除我的记忆”.`;
  }

  if (locale === "zh") {
    const enabledKinds = [
      policy.contactMemoryEnabled
        ? "通过自动安全策略的联系人偏好、目标、约束与必要背景"
        : null,
      policy.representativeExperienceEnabled
        ? "去标识化、经多来源聚合并通过自动策略的代表经验"
        : null,
    ].filter((value): value is string => value !== null).join("；");
    const scopes = [
      policy.contactMemoryEnabled
        ? policy.contactMemoryCrossChannelEnabled
          ? "联系人记忆始终限定在当前联系人和当前数字代表；Web、Matrix、Telegram 私聊映射到同一已验证 Delegate 身份后默认开启安全摘要共享，联系人可随时关闭，原始会话仍分别保存"
          : "联系人记忆严格限定在当前联系人、当前数字代表和 Web 渠道，其他联系人、代表或渠道不可见"
        : null,
      policy.representativeExperienceEnabled
        ? "代表经验只服务当前数字代表，可面向其访客使用，但不包含任何联系人身份或个人事实"
        : null,
    ].filter((value): value is string => value !== null).join("；");
    const extraction = policy.automaticExtractionEnabled
      ? "Web 消息中的低风险结构化内容只有通过自动来源、范围和安全策略后才会生效；不确定、敏感或格式无效的内容自动阻止"
      : "本次 Web 对话不会自动提取新的长期记忆；只有已有且仍通过当前策略的安全摘要可用于回答";
    const expiry = policy.expiryAction === "ARCHIVE"
      ? "到期后归档并停止召回"
      : "到期后立即停止召回并进入可审计的异步清理";
    return `长期记忆已启用。可使用的记忆类型包括：${enabledKinds}。作用范围：${scopes}。${extraction}。${policy.shortTermMemoryEnabled ? "同一会话阶段内还可使用有界的短期上下文；短期上下文不写入 OpenViking。" : "短期上下文已关闭。"}原始聊天全文、Owner 私有备注、Compute 或工具原始产物、凭据，以及付款、余额、退款和权益信息不会直接进入长期记忆，也不会读取 Owner 的私有工作区、文件或账号。生效记忆保留 ${retentionDays} 天，${expiry}。聊天内自助查看和纠正尚未提供；发送“删除我的记忆”可立即停止召回并异步清理当前代表与当前 Web 渠道下的联系人记忆${policy.contactMemoryCrossChannelEnabled ? "；跨渠道身份区可单独撤回并删除共享联系人记忆" : ""}。`;
  }

  const enabledKinds = [
    policy.contactMemoryEnabled
      ? "contact preferences, goals, constraints, and necessary context that pass automated safety policy"
      : null,
    policy.representativeExperienceEnabled
      ? "deidentified representative experience aggregated across sources and accepted by automated policy"
      : null,
  ].filter((value): value is string => value !== null).join("; ");
  const scopes = [
    policy.contactMemoryEnabled
      ? policy.contactMemoryCrossChannelEnabled
        ? "contact memory is always restricted to this contact and this representative; safe-summary sharing defaults on after Web, Matrix, and Telegram private chats resolve to the same verified Delegate identity, the contact can turn it off at any time, and raw conversations remain separate"
        : "contact memory is restricted to this contact, this representative, and the Web channel; no other contact, representative, or channel can see it"
      : null,
    policy.representativeExperienceEnabled
      ? "representative experience serves only this representative across visitors and contains no contact identity or personal facts"
      : null,
  ].filter((value): value is string => value !== null).join("; ");
  const extraction = policy.automaticExtractionEnabled
    ? "low-risk structured content from Web messages becomes active only after automated source, scope, and safety policy checks; uncertain, sensitive, or malformed content is blocked"
    : "this Web conversation does not automatically extract new long-term memory; only existing safe summaries that still pass current policy may support a reply";
  const expiry = policy.expiryAction === "ARCHIVE"
    ? "then it is archived and no longer recalled"
    : "then recall stops immediately and auditable asynchronous cleanup begins";
  return `Long-term memory is enabled. Eligible memory types are: ${enabledKinds}. Scope: ${scopes}. ${extraction}. ${policy.shortTermMemoryEnabled ? "Bounded recent context from the current conversation stage may also be used; short-term context is not written to OpenViking. " : "Short-term context is disabled. "}Raw chat transcripts, private Owner notes, raw Compute or tool output, credentials, and payment, balance, refund, or entitlement data do not enter long-term memory directly, and the Owner's private workspace, files, and accounts are never accessed. Active memory is retained for ${retentionDays} days; ${expiry}. Self-service viewing and correction are not yet available; send “删除我的记忆” to stop recall immediately and asynchronously delete Contact Memory for this representative and Web channel${policy.contactMemoryCrossChannelEnabled ? "; separately revoke shared Contact Memory in the cross-channel identity section" : ""}.`;
}
