import { z } from "zod";

export const workFields = [
  "互联网",
  "销售",
  "IT / 技术",
  "产品",
  "金融",
  "自媒体",
  "设计",
  "教育",
  "咨询",
  "其他",
] as const;
export const expressionStyles = [
  {
    name: "专业稳重",
    description: "条理清楚，用词准确",
    text: "表达专业、稳重，先给结论再说明依据，用词准确，不夸大承诺。",
    sample: "可以。我们先明确目标和约束，再整理一份可执行的建议。",
  },
  {
    name: "简洁直接",
    description: "少些铺垫，直奔重点",
    text: "表达简洁直接，先回答重点，用短句说明结论与下一步，避免重复和冗长铺垫。",
    sample: "可以。先告诉我你的目标、预算和时间，我帮你梳理下一步。",
  },
  {
    name: "亲切自然",
    description: "像日常交流一样轻松",
    text: "表达亲切自然，使用容易理解的日常语言，认真回应对方，保持友好且有分寸。",
    sample: "当然可以呀。先聊聊你现在最想解决的事，我们一起理一理。",
  },
  {
    name: "耐心引导",
    description: "循序渐进，逐步问清楚",
    text: "表达耐心，循序渐进地解释和提问，每次聚焦一个问题，帮助对方理清需求。",
    sample: "没关系，我们一步步来。你最希望先解决哪一个问题？",
  },
  {
    name: "幽默风趣",
    description: "适度幽默，保持分寸",
    text: "表达轻松幽默，可适度使用贴切的比喻，保持专业和分寸；严肃问题认真回应，不拿对方的困扰开玩笑。",
    sample: "可以，我们先把这团毛线理顺。你最想先解决哪件事？",
  },
] as const;
const limitedText = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => Array.from(v).length <= max, `最多 ${max} 字`);
export const onboardingDraftSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  step: z.number().int().min(0).max(3),
  fields: z.array(z.enum(workFields)).max(10),
  customField: limitedText(80),
  name: limitedText(60),
  services: limitedText(500),
  tone: z.number().int().min(0).max(4),
  avatarUrl: z.string().max(2048).default(""),
});
export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;
export function onboardingDirections(draft: OnboardingDraft) {
  return [
    ...new Set([
      ...draft.fields.filter((f) => f !== "其他"),
      ...(draft.customField.trim() ? [draft.customField.trim()] : []),
    ]),
  ];
}
export function onboardingStepError(
  draft: OnboardingDraft,
  step: number,
): string | null {
  if (
    step === 0 &&
    (!onboardingDirections(draft).length ||
      (draft.fields.includes("其他") && !draft.customField.trim()))
  )
    return "请选择工作领域，选择其他时请补充工作方向。";
  if (step === 1 && !draft.name.trim()) return "请填写对外代理名称。";
  if (step === 2 && !draft.services.trim()) return "请填写服务内容。";
  return null;
}
export const onboardingCreateSchema = onboardingDraftSchema.superRefine(
  (draft, ctx) => {
    for (let step = 0; step < 4; step++) {
      const message = onboardingStepError(draft, step);
      if (message)
        ctx.addIssue({
          code: "custom",
          message,
          path: [step === 0 ? "fields" : step === 1 ? "name" : "services"],
        });
    }
  },
);
export function generateRepresentativeBasics(
  draft: OnboardingDraft,
  ownerName: string,
) {
  return {
    name: draft.name.trim(),
    tagline: draft.services.trim(),
    tone: expressionStyles[draft.tone]!.text,
    identitySummary: `${ownerName}主要从事${onboardingDirections(draft).join("、")}相关工作。`,
    languages: ["zh", "en"],
  };
}
const serviceOptions: Record<string, string[]> = {
  互联网: ["介绍产品与业务", "解答常见问题", "整理合作需求"],
  销售: ["介绍产品与服务", "了解客户需求", "筛选合作线索"],
  "IT / 技术": ["解答技术问题", "梳理技术需求", "整理问题排查建议"],
  产品: ["讨论产品思路", "梳理用户需求", "整理产品反馈"],
  金融: ["介绍业务与服务范围", "解释基础概念", "整理咨询需求"],
  自媒体: ["介绍内容与合作方式", "解答粉丝问题", "整理商务合作需求"],
  设计: ["介绍作品与服务", "梳理设计需求", "整理项目简报"],
  教育: ["介绍课程与学习服务", "解答学习问题", "整理学习需求"],
  咨询: ["介绍咨询服务", "梳理客户问题", "整理需求摘要"],
};
export function suggestedServices(fields: string[]) {
  return [...new Set(fields.flatMap((f) => serviceOptions[f] ?? []))].slice(
    0,
    6,
  );
}
