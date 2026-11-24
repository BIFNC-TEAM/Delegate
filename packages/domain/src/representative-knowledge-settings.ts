import { z } from "zod";

export const boundaryPresets = [
  {
    id: "appointment",
    name: "见面与会议安排",
    description: "确认或更改见面、会议时间",
    action: "approve",
    example: "想约你下周三下午两点开个会，可以吗？",
  },
  {
    id: "discount",
    name: "特殊报价与折扣",
    description: "折扣、特殊报价或付款条件变更",
    action: "approve",
    example: "这次合作可以给我打八折吗？",
  },
  {
    id: "scope",
    name: "额外交付与承诺",
    description: "超出既定服务范围的交付或保证",
    action: "approve",
    example: "能额外帮我们执行推广，并保证获客效果吗？",
  },
  {
    id: "dispute",
    name: "投诉与争议",
    description: "需要本人协商处理的服务问题",
    action: "handoff",
    example: "这次交付没有达到约定，我想和负责人沟通。",
  },
  {
    id: "human",
    name: "希望与你本人交流",
    description: "访客明确提出由创建者本人接待",
    action: "handoff",
    example: "我想直接和你本人聊一聊，可以吗？",
  },
] as const;
export const boundaryLabels = {
  approve: "需要我审批",
  handoff: "需要我接手",
  decline: "不提供此类服务",
};
export const knowledgeSettingsSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          allowDownload: z.boolean(),
        }),
      )
      .max(200),
    featuredFaqIds: z.array(z.string().min(1)).max(3),
    faqSources: z.record(z.string().max(100), z.string().max(600)).optional(),
    boundaries: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          request: z.string().trim().max(200),
          action: z.enum(["approve", "handoff", "decline"]),
        }),
      )
      .max(50),
  })
  .superRefine((value, ctx) => {
    for (const ids of [
      value.files.map((f) => f.id),
      value.featuredFaqIds,
      value.boundaries.map((b) => b.id),
    ]) {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "配置中存在重复项目。" });
    }
    if (
      boundaryPresets.some((p) => !value.boundaries.some((b) => b.id === p.id))
    )
      ctx.addIssue({ code: "custom", message: "请保留完整的预设服务边界。" });
    if (
      value.boundaries.some(
        (b) => !boundaryPresets.some((p) => p.id === b.id) && !b.request,
      )
    )
      ctx.addIssue({ code: "custom", message: "请填写自定义请求。" });
  });
export type KnowledgeSettings = z.infer<typeof knowledgeSettingsSchema>;
export function defaultKnowledgeSettings(
  ids: string[] = [],
): KnowledgeSettings {
  return {
    version: 1,
    files: ids.map((id) => ({ id, allowDownload: false })),
    featuredFaqIds: [],
    boundaries: boundaryPresets.map((p) => ({
      id: p.id,
      request: "",
      action: p.action,
    })),
  };
}
export function normalizeFaqQuestion(value: string) {
  // Only remove incidental input padding; punctuation, case and wording stay significant.
  return value.trim();
}
