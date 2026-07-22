import { z } from "zod";

import type {
  NaturalLanguageComputePlan,
  NaturalLanguageDelegationPlan,
} from "@delegate/runtime";
import type { RepresentativeReplyPrompt } from "./types";

const computeStepSchema = z.object({
  capability: z.enum(["exec", "read", "write", "process", "browser"]),
  summary: z.string().trim().min(1).max(160),
  command: z.string().trim().min(1).max(4000).optional(),
  path: z.string().trim().min(1).max(500).optional(),
  content: z.string().min(1).max(50_000).optional(),
  url: z.string().url().max(2000).optional(),
});

const computePlanSchema = z.union([
  z.object({ needsCompute: z.literal(false) }),
  z.object({
    needsCompute: z.literal(true),
    summary: z.string().trim().min(1).max(160),
    steps: z.array(computeStepSchema).min(1).max(5),
  }),
  z.object({
    needsCompute: z.literal(true),
    summary: z.string().trim().min(1).max(160),
    clarification: z.object({
      question: z.string().trim().min(1).max(500),
      missingFields: z.array(z.enum(["command", "path", "content", "url"])).min(1).max(4),
    }),
  }),
]);

export function buildNaturalLanguageComputePrompt(userText: string): RepresentativeReplyPrompt {
  return {
    instructions: [
      "You are a conservative planner for an isolated compute sandbox used by a public AI representative.",
      "Return exactly one JSON object and no markdown.",
      "Set needsCompute=false for questions, explanations, brainstorming, requests about how Compute works, or tasks answerable without executing tools.",
      "Set needsCompute=true only when the user explicitly asks to read/write files, run concrete commands/scripts, or open concrete public URLs.",
      "Never invent a path, URL, command, file content, credential, or private input that the user did not supply.",
      "Return 1-5 ordered steps only when every step is concrete and grounded in the user input.",
      "If the user clearly requests execution but a required path, URL, command, or complete file content is missing, return clarification instead of steps.",
      "Use write only when both the target path and complete intended content are available.",
      "Use browser only when an http:// or https:// URL is present.",
      "Use exec/process only when the concrete command or code is present. Prefer exec for one-shot commands.",
      "Schema when no compute is needed: {\"needsCompute\":false}.",
      "Execution schema: {\"needsCompute\":true,\"summary\":\"overall result\",\"steps\":[{\"capability\":\"read|write|exec|process|browser\",\"summary\":\"step\",\"path\":\"optional\",\"content\":\"optional\",\"command\":\"optional\",\"url\":\"optional\"}]}.",
      "Clarification schema: {\"needsCompute\":true,\"summary\":\"requested result\",\"clarification\":{\"question\":\"one focused question\",\"missingFields\":[\"path|content|command|url\"]}}.",
    ].join("\n"),
    input: userText,
  };
}

export function parseNaturalLanguageComputePlan(value: string): NaturalLanguageDelegationPlan | null {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    throw new Error("Compute planner returned invalid JSON.");
  }
  const parsed = computePlanSchema.parse(decoded);
  if (!parsed.needsCompute) return null;
  if ("clarification" in parsed) {
    return {
      kind: "clarification",
      summary: parsed.summary,
      question: parsed.clarification.question,
      missingFields: parsed.clarification.missingFields,
    };
  }
  const steps: NaturalLanguageComputePlan[] = parsed.steps.map((step) => ({
    capability: step.capability,
    summary: step.summary,
    ...(step.command ? { command: step.command } : {}),
    ...(step.path ? { path: step.path } : {}),
    ...(step.content ? { content: step.content } : {}),
    ...(step.url ? { url: step.url } : {}),
  }));
  if (!steps.every(isCompleteComputeStep)) return null;
  return { kind: "execution", summary: parsed.summary, steps };
}

export function isNaturalLanguageComputePlanGrounded(
  plan: NaturalLanguageDelegationPlan,
  userText: string,
) {
  if (plan.kind === "clarification") return true;
  const source = userText.normalize("NFKC");
  return plan.steps.flatMap((step) => [step.path, step.url, step.command, step.content])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .every((value) => source.includes(value.normalize("NFKC")));
}

export function inferDeterministicNaturalLanguageComputePlan(
  userText: string,
): NaturalLanguageDelegationPlan | null {
  const text = userText.trim();
  const url = text.match(/https?:\/\/[^\s<>"'，。！？]+/i)?.[0];
  if (url && /(?:打开|访问|浏览|检查|测试|open|visit|browse|inspect|test)/i.test(text)) {
    return executionPlan(`浏览 ${url}`, { capability: "browser", url, summary: `浏览 ${url}` });
  }

  const explicitCommand =
    text.match(/(?:运行|执行)(?:以下|这个)?(?:命令|脚本|代码)\s*[：:]?\s*`([^`]+)`/i)?.[1] ??
    text.match(/\b(?:run|execute)\s+(?:this\s+)?(?:command|script|code)\s*[：:]?\s*`([^`]+)`/i)?.[1];
  if (explicitCommand) {
    return executionPlan("运行用户提供的命令", { capability: "exec", command: explicitCommand.trim(), summary: "运行用户提供的命令" });
  }

  const pathPattern = "([A-Za-z0-9_./-]+\\.(?:md|txt|json|csv|log))";
  const readMatch = text.match(new RegExp(`(?:读取|查看|分析|read|inspect|analyze)\\s*(?:文件)?\\s*[“\"']?${pathPattern}`, "i"));
  if (readMatch?.[1]) {
    return executionPlan(`读取 ${readMatch[1]}`, { capability: "read", path: readMatch[1], summary: `读取 ${readMatch[1]}` });
  }

  const writeMatch = text.match(new RegExp(`(?:把|将)\\s*[“\"']?(.+?)[”\"']?\\s*(?:写入|保存到|保存为)\\s*[“\"']?${pathPattern}`, "i"));
  if (writeMatch?.[1] && writeMatch[2]) {
    return executionPlan(`生成 ${writeMatch[2]}`, {
      capability: "write",
      path: writeMatch[2],
      content: writeMatch[1].trim(),
      summary: `生成 ${writeMatch[2]}`,
    });
  }

  const labeledPath = text.match(new RegExp(`(?:目标)?(?:路径|path)\\s*[：:]?\\s*[“\"']?${pathPattern}`, "i"))?.[1];
  const labeledContent = text.match(/(?:完整)?(?:内容|content)\s*[：:]\s*([^\n]+)/i)?.[1]?.trim();
  if (labeledPath && labeledContent && /(?:保存|写入|生成|创建|导出|文件|文档|report)/i.test(text)) {
    return executionPlan(`生成 ${labeledPath}`, {
      capability: "write",
      path: labeledPath,
      content: labeledContent,
      summary: `生成 ${labeledPath}`,
    });
  }

  if (/(?:保存|写入|生成|创建|导出).{0,32}(?:文件|文档|markdown|md|txt|json|csv|报告)/i.test(text)) {
    return {
      kind: "clarification",
      summary: "准备文件",
      question: "请补充目标文件路径和需要写入的完整内容。",
      missingFields: ["path", "content"],
    };
  }

  return null;
}

function executionPlan(summary: string, step: NaturalLanguageComputePlan): NaturalLanguageDelegationPlan {
  return { kind: "execution", summary, steps: [step] };
}

function isCompleteComputeStep(step: NaturalLanguageComputePlan) {
  if (step.capability === "read") return Boolean(step.path);
  if (step.capability === "write") return Boolean(step.path && step.content);
  if (step.capability === "browser") return Boolean(step.url);
  return Boolean(step.command);
}
