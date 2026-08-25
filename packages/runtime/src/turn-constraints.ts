import { z } from "zod";

export const turnToolPolicySchema = z.enum([
  "auto",
  "forbidden",
  "required",
  "conflict",
]);

export const turnConstraintsSchema = z.object({
  scope: z.literal("turn"),
  toolPolicy: turnToolPolicySchema,
  source: z.enum(["default", "explicit_user_instruction"]),
  sourcePointers: z.array(z.string().regex(/^\//)).max(8),
}).strict();

export type TurnConstraints = z.infer<typeof turnConstraintsSchema>;

export const defaultTurnConstraints: TurnConstraints = Object.freeze({
  scope: "turn",
  toolPolicy: "auto",
  source: "default",
  sourcePointers: [],
});

export function deriveTurnConstraintsFromMessage(text: string): TurnConstraints {
  const normalized = text.normalize("NFKC");
  const forbidsTools = [
    /(?:不要|不用|无需|不得|禁止|不允许|请勿|别)(?:再)?(?:使用|调用|运行)?(?:任何)?(?:外部)?(?:工具|MCP|Compute|Skill)/iu,
    /(?:without|do\s+not|don't|must\s+not|never)\s+(?:use|using|call|invoke)?\s*(?:any\s+)?(?:tools?|mcp|compute|skills?)/iu,
  ].some((pattern) => pattern.test(normalized));
  const requiresTools = [
    /(?:必须|请|需要|要求)(?:使用|调用|通过)(?:指定的)?(?:工具|MCP|Compute|Skill)/iu,
    /(?:^|[，。！？；\s])(?:使用|调用|通过)(?:指定的|可用的|任一)?(?:工具|MCP|Compute|Skill)(?:查询|检索|执行|处理|获取|完成)?/iu,
    /(?:信息|结论|回答).{0,12}(?:来自|基于)(?:实际)?工具结果/iu,
    /(?:must|please|required?\s+to)\s+(?:use|call|invoke)\s+(?:a\s+|the\s+)?(?:tool|mcp|compute|skill)/iu,
    /(?:answer|information|result).{0,24}(?:from|based\s+on)\s+(?:an?\s+|the\s+)?tool\s+(?:result|output)/iu,
  ].some((pattern) => pattern.test(normalized));

  const toolPolicy = forbidsTools && requiresTools
    ? "conflict"
    : forbidsTools
      ? "forbidden"
      : requiresTools
        ? "required"
        : "auto";
  return turnConstraintsSchema.parse({
    scope: "turn",
    toolPolicy,
    source: toolPolicy === "auto" ? "default" : "explicit_user_instruction",
    sourcePointers: toolPolicy === "auto" ? [] : ["/currentMessage/text"],
  });
}
