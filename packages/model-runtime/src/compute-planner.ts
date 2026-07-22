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

export function buildNaturalLanguageComputePrompt(
  userText: string,
  maxSteps = 5,
): RepresentativeReplyPrompt {
  const boundedMaxSteps = Math.max(1, Math.min(5, Math.floor(maxSteps)));
  const defaultGeneratedDocumentPath = buildDefaultGeneratedDocumentPath(userText);
  return {
    instructions: [
      "You are a conservative planner for an isolated compute sandbox used by a public AI representative.",
      "Return exactly one JSON object and no markdown.",
      "Set needsCompute=false for questions, explanations, brainstorming, requests about how Compute works, or tasks answerable without executing tools.",
      "Set needsCompute=true only when the user explicitly asks to read/write files, create a report or other document artifact, run concrete commands/scripts, or open concrete public URLs.",
      "Never invent a user-controlled path, URL, command, credential, or private input that the user did not supply.",
      `Return 1-${boundedMaxSteps} ordered steps only when every step is concrete and grounded in the planner input.`,
      "If the user clearly requests execution but a required path, URL, command, or complete file content is missing, return clarification instead of steps.",
      "Use write only when both the target path and complete intended content are available.",
      "Treat requests to generate reports, summaries, plans, lessons, stories, or other documents as generated-document tasks, not as low-level file writes.",
      "For generated-document tasks, ask only for missing business requirements such as topic, source material, audience, and output format. Never ask the user for a sandbox path or for already-written final content.",
      "Source material is optional for templates, checklists, meeting notes, test records, specifications, and other documents that can be drafted solely from explicit user requirements.",
      `When generated-document requirements are sufficient, author a concise Markdown draft and write it only to this system-owned path: ${defaultGeneratedDocumentPath}`,
      "Do not claim to have used source material that is not included in the planner input.",
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
      question: buildSafeClarificationQuestion(
        parsed.clarification.missingFields,
        parsed.clarification.question,
      ),
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
  if (isInformationalRequest(userText.trim())) return false;
  if (plan.kind === "clarification") return true;
  if (isGeneratedDocumentRequest(userText)) {
    if (!hasSufficientGeneratedDocumentRequirements(userText) || plan.steps.length !== 1) {
      return false;
    }
    const [step] = plan.steps;
    return step?.capability === "write" &&
      step.path === buildDefaultGeneratedDocumentPath(userText) &&
      typeof step.content === "string" && step.content.trim().length > 0;
  }
  const source = userText.normalize("NFKC");
  return plan.steps.flatMap((step) => [step.path, step.url, step.command, step.content])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .every((value) => source.includes(value.normalize("NFKC")));
}

export function inferDeterministicNaturalLanguageComputePlan(
  userText: string,
): NaturalLanguageDelegationPlan | null {
  const text = userText.trim();
  if (isInformationalRequest(text)) return null;
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

  if (isGeneratedDocumentRequest(text)) {
    if (hasSufficientGeneratedDocumentRequirements(text)) {
      const path = buildDefaultGeneratedDocumentPath(text);
      return executionPlan("生成用户请求的文档初稿", {
        capability: "write",
        path,
        content: buildDeterministicGeneratedDocument(text),
        summary: "生成用户请求的文档初稿",
      });
    }
    return {
      kind: "clarification",
      summary: "准备生成文档",
      question: "请说明要生成的内容主题、可用资料、目标读者和期望格式；文件位置由系统自动管理。",
      missingFields: ["content"],
    };
  }

  if (/(?:保存|写入|生成|创建|导出).{0,32}(?:文件|markdown|md|txt|json|csv)/i.test(text)) {
    return {
      kind: "clarification",
      summary: "准备文件",
      question: "请说明要生成或保存的具体内容；文件位置由系统自动管理。",
      missingFields: ["content"],
    };
  }

  return null;
}

function buildSafeClarificationQuestion(
  missingFields: Array<"command" | "path" | "content" | "url">,
  languageSample: string,
) {
  const fields = new Set(missingFields);
  const chinese = /\p{Script=Han}/u.test(languageSample);

  if (fields.size === 2 && fields.has("path") && fields.has("content")) {
    return chinese
      ? "请说明要生成的内容主题、可用资料、目标读者和期望格式；文件位置由系统自动管理。"
      : "Please describe the topic, source material, audience, and desired format; the system will manage the file location.";
  }
  if (fields.size === 1 && fields.has("content")) {
    return chinese
      ? "请说明要生成的内容主题、可用资料、目标读者和期望格式；文件位置由系统自动管理。"
      : "Please describe the topic, source material, audience, and desired format; the system will manage the file location.";
  }
  if (fields.size === 1 && fields.has("command")) {
    return chinese
      ? "请提供要在隔离沙盒中运行的完整命令或脚本。"
      : "Please provide the complete command or script to run in the isolated sandbox.";
  }
  if (fields.size === 1 && fields.has("url")) {
    return chinese
      ? "请提供需要访问的公开 HTTP(S) URL。"
      : "Please provide the public HTTP(S) URL to visit.";
  }

  const labels = chinese
    ? { command: "完整命令或脚本", path: "目标文件路径", content: "完整文件内容", url: "公开 HTTP(S) URL" }
    : { command: "complete command or script", path: "target file path", content: "complete file content", url: "public HTTP(S) URL" };
  const requested = [...fields].map((field) => labels[field]).join(chinese ? "、" : ", ");
  return chinese
    ? `请补充以下执行信息：${requested}。`
    : `Please provide the following execution details: ${requested}.`;
}

function isInformationalRequest(text: string) {
  return /(?:如何|怎么|怎样)|^(?:请)?(?:解释|说明|介绍|讲解)|^(?:please\s+)?(?:explain|describe)|\bhow\s+(?:do|can|should|would)\b|\bhow\s+to\b/i.test(text);
}

export function buildDefaultGeneratedDocumentPath(userText: string) {
  let hash = 0x811c9dc5;
  for (const character of userText.normalize("NFKC")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `outputs/report-${(hash >>> 0).toString(16).padStart(8, "0")}.md`;
}

function isGeneratedDocumentRequest(text: string) {
  return /(?:生成|创建|撰写|编写|制作|写|做|导出).{0,40}(?:报告|文档|总结|方案|教案|故事|记录|纪要|清单|表格|简历|邮件|说明|规范)|\b(?:generate|create|write|draft|prepare|export)\b.{0,40}\b(?:report|document|summary|plan|lesson|story|record|notes|minutes|checklist|table|resume|email|specification|spec)\b/i.test(text);
}

function hasSufficientGeneratedDocumentRequirements(text: string) {
  const supplement = text.match(/(?:用户补充|additional user input)\s*[：:]\s*([\s\S]+)/i)?.[1]?.trim();
  const candidate = (supplement || text)
    .replace(/(?:请|帮我|麻烦)?(?:生成|创建|撰写|编写|制作|写|做|导出)/gi, "")
    .replace(/(?:一份|一个)?(?:报告|报告文件|文档|总结|方案|教案|故事|记录|纪要|清单|表格|简历|邮件|说明|规范|文件)/gi, "")
    .replace(/(?:原始任务|待补充|用户补充|additional user input)\s*[：:]?/gi, "")
    .replace(/(?:路径|path)\s*[：:]?\s*\S+/gi, "")
    .replace(/[\s，。！？、,:;；'“”\"`]/g, "");
  return candidate.length >= 8;
}

function buildDeterministicGeneratedDocument(userText: string) {
  const request = userText
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
  const isChecklistOrRecord = /(?:测试|qa|检查|验收|记录|清单|checklist|test|verification)/i.test(request);
  if (isChecklistOrRecord) {
    return [
      "# 检查记录初稿",
      "",
      "## 需求摘要",
      "",
      request,
      "",
      "## 范围",
      "",
      "- 按上述需求覆盖目标功能与约束。",
      "",
      "## 检查步骤",
      "",
      "1. 准备需求中明确的输入与前置条件。",
      "2. 按目标流程执行并记录实际结果。",
      "3. 对照预期结果或通过标准完成复核。",
      "",
      "## 预期结果 / 通过标准",
      "",
      "- 需求中明确的流程可以完成，结果与约束一致。",
      "- 未出现越权执行、未授权副作用或未说明的失败。",
      "",
      "> 本初稿仅依据用户提供的要求生成，未引用未提供的外部事实。",
    ].join("\n");
  }
  return [
    "# 文档初稿",
    "",
    "## 用户要求",
    "",
    request,
    "",
    "## 初稿说明",
    "",
    "本文档依据上述要求整理。需补充的数据、结论或外部事实应由用户或已授权资料提供。",
  ].join("\n");
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
