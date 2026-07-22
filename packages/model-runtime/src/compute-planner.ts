import { z } from "zod";

import type { NaturalLanguageComputePlan } from "@delegate/runtime";
import type { RepresentativeReplyPrompt } from "./types";

const computePlanSchema = z.discriminatedUnion("needsCompute", [
  z.object({ needsCompute: z.literal(false) }),
  z.object({
    needsCompute: z.literal(true),
    capability: z.enum(["exec", "read", "write", "process", "browser"]),
    summary: z.string().trim().min(1).max(160),
    command: z.string().trim().min(1).max(4000).optional(),
    path: z.string().trim().min(1).max(500).optional(),
    content: z.string().min(1).max(50_000).optional(),
    url: z.string().url().max(2000).optional(),
  }),
]);

export function buildNaturalLanguageComputePrompt(userText: string): RepresentativeReplyPrompt {
  return {
    instructions: [
      "You are a conservative planner for an isolated compute sandbox used by a public AI representative.",
      "Return exactly one JSON object and no markdown.",
      "Set needsCompute=false for questions, explanations, brainstorming, requests about how Compute works, or tasks answerable without executing tools.",
      "Set needsCompute=true only when the user explicitly asks to read/write a file, run a concrete command/script, or open a concrete public URL.",
      "Never invent a path, URL, command, file content, credential, or private input that the user did not supply.",
      "Use write only when both the target path and complete intended content are available.",
      "Use browser only when an http:// or https:// URL is present.",
      "Use exec/process only when the concrete command or code is present. Prefer exec for one-shot commands.",
      "Schema when no compute is needed: {\"needsCompute\":false}.",
      "Schema when needed: {\"needsCompute\":true,\"capability\":\"read|write|exec|process|browser\",\"summary\":\"short user-facing action\",\"path\":\"optional\",\"content\":\"optional\",\"command\":\"optional\",\"url\":\"optional\"}.",
    ].join("\n"),
    input: userText,
  };
}

export function parseNaturalLanguageComputePlan(value: string): NaturalLanguageComputePlan | null {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    throw new Error("Compute planner returned invalid JSON.");
  }
  const parsed = computePlanSchema.parse(decoded);
  if (!parsed.needsCompute) return null;

  if (parsed.capability === "read" && !parsed.path) return null;
  if (parsed.capability === "write" && (!parsed.path || !parsed.content)) return null;
  if (parsed.capability === "browser" && !parsed.url) return null;
  if ((parsed.capability === "exec" || parsed.capability === "process") && !parsed.command) return null;

  return {
    capability: parsed.capability,
    summary: parsed.summary,
    ...(parsed.command ? { command: parsed.command } : {}),
    ...(parsed.path ? { path: parsed.path } : {}),
    ...(parsed.content ? { content: parsed.content } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
  };
}

export function isNaturalLanguageComputePlanGrounded(
  plan: NaturalLanguageComputePlan,
  userText: string,
) {
  const source = userText.normalize("NFKC");
  return [plan.path, plan.url, plan.command, plan.content]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .every((value) => source.includes(value.normalize("NFKC")));
}

export function inferDeterministicNaturalLanguageComputePlan(
  userText: string,
): NaturalLanguageComputePlan | null {
  const text = userText.trim();
  const url = text.match(/https?:\/\/[^\s<>"'，。！？]+/i)?.[0];
  if (url && /(?:打开|访问|浏览|检查|测试|open|visit|browse|inspect|test)/i.test(text)) {
    return { capability: "browser", url, summary: `浏览 ${url}` };
  }

  const explicitCommand =
    text.match(/(?:运行|执行)(?:以下|这个)?(?:命令|脚本|代码)\s*[：:]?\s*`([^`]+)`/i)?.[1] ??
    text.match(/\b(?:run|execute)\s+(?:this\s+)?(?:command|script|code)\s*[：:]?\s*`([^`]+)`/i)?.[1];
  if (explicitCommand) {
    return { capability: "exec", command: explicitCommand.trim(), summary: "运行用户提供的命令" };
  }

  const pathPattern = "([A-Za-z0-9_./-]+\\.(?:md|txt|json|csv|log))";
  const readMatch = text.match(new RegExp(`(?:读取|查看|分析|read|inspect|analyze)\\s*(?:文件)?\\s*[“\"']?${pathPattern}`, "i"));
  if (readMatch?.[1]) {
    return { capability: "read", path: readMatch[1], summary: `读取 ${readMatch[1]}` };
  }

  const writeMatch = text.match(new RegExp(`(?:把|将)\\s*[“\"']?(.+?)[”\"']?\\s*(?:写入|保存到|保存为)\\s*[“\"']?${pathPattern}`, "i"));
  if (writeMatch?.[1] && writeMatch[2]) {
    return {
      capability: "write",
      path: writeMatch[2],
      content: writeMatch[1].trim(),
      summary: `生成 ${writeMatch[2]}`,
    };
  }

  return null;
}
