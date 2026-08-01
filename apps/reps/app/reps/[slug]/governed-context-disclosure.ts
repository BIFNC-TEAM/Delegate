export function getGovernedContextDisclosure(
  locale: "zh" | "en",
  governedContextEnabled: boolean,
): string {
  if (locale === "zh") {
    return governedContextEnabled
      ? "受治理的长期上下文当前已启用：仅在这个数字代表范围内调用已获准的安全摘要，用于让后续回复保持连贯。当前原始对话不会自动写入长期记忆，也不会读取主人的私有工作区、文件或账号。"
      : "长期上下文当前未启用：本次聊天不会形成或调用跨会话长期记忆。回答仍只使用当前已发布的公开资料，原始对话不会自动成为公开知识。";
  }

  return governedContextEnabled
    ? "Governed long-term context is enabled: only approved, safe summaries scoped to this representative may support continuity in later replies. Raw chat is not automatically written to long-term memory, and the owner's private workspace, files, and accounts are never accessed."
    : "Long-term context is disabled: this chat does not create or use memory across conversations. Replies still use only the currently published public sources, and raw chat does not automatically become public knowledge.";
}
