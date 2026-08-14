const legacyMultiFieldHandoffPrompt =
  "请留下你的身份、需求摘要、预算区间、目标时间，以及为什么需要真人接手";

const requestDescriptionHandoffPrompt =
  "请简要描述你的需求；真人接手后会再确认联系人、预算和时间等必要信息。";

export function normalizeRepresentativeHandoffPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) return requestDescriptionHandoffPrompt;

  const legacyPromptIndex = prompt.indexOf(legacyMultiFieldHandoffPrompt);
  if (legacyPromptIndex === -1) return prompt;

  return `${prompt.slice(0, legacyPromptIndex)}${requestDescriptionHandoffPrompt}`;
}
