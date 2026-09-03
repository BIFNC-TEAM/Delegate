import { createHash } from "node:crypto";

import { z } from "zod";

import type { CompiledSandboxTaskMetadata } from "@delegate/runtime";
import type { RepresentativeReplyPrompt } from "./types";

export const SANDBOX_TASK_COMPILER_VERSION = "sandbox-task-compiler.v1" as const;
export const DEFAULT_SANDBOX_TASK_MAX_CODE_BYTES = 12 * 1024;

const allowedImportRoots = new Set([
  "bisect",
  "calendar",
  "collections",
  "csv",
  "datetime",
  "decimal",
  "fractions",
  "functools",
  "heapq",
  "itertools",
  "json",
  "math",
  "operator",
  "re",
  "statistics",
  "string",
]);

const compilerProposalSchema = z.discriminatedUnion("needsExecution", [
  z.object({
    needsExecution: z.literal(false),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    needsExecution: z.literal(true),
    summary: z.string().trim().min(1).max(200),
    language: z.literal("python"),
    riskClass: z.literal("self_contained_compute"),
    code: z.string().min(1).max(50_000),
  }).strict(),
]);

export type SandboxTaskCompilerProposal = z.infer<typeof compilerProposalSchema>;

export type CompiledSandboxTask = {
  summary: string;
  command: string;
  metadata: CompiledSandboxTaskMetadata;
};

export type SandboxTaskCompilerResult =
  | {
      ok: true;
      task: CompiledSandboxTask | null;
      reason?: string;
      provider?: string;
      model?: string;
    }
  | {
      ok: false;
      reason: string;
      state: string;
    };

export function buildSandboxTaskCompilerPrompt(
  instruction: string,
  maxCodeBytes = DEFAULT_SANDBOX_TASK_MAX_CODE_BYTES,
): RepresentativeReplyPrompt {
  return {
    instructions: [
      "You compile one natural-language request into one self-contained Python program for an isolated sandbox.",
      "Return exactly one JSON object and no markdown.",
      "Use needsExecution=true only when all information needed for the computation is present in the user instruction.",
      "The program must compute solely from literals included in the instruction and Python standard-library pure-data modules.",
      "The program must print the requested result to stdout.",
      "Do not read or write files, inspect environment variables, use credentials, access networks or URLs, spawn processes or threads, install packages, use dynamic imports, or call external services.",
      "Do not use eval, exec, compile, __import__, dunder attributes, reflection, interactive input, or infinite loops.",
      `Keep UTF-8 Python source below ${maxCodeBytes} bytes.`,
      "If the request needs missing data, attachments, files, network access, packages, persistence, a browser, or an external side effect, return needsExecution=false with a short reason.",
      "Execution schema: {\"needsExecution\":true,\"summary\":\"short result goal\",\"language\":\"python\",\"riskClass\":\"self_contained_compute\",\"code\":\"python source\"}.",
      "No-execution schema: {\"needsExecution\":false,\"reason\":\"short reason\"}.",
    ].join("\n"),
    input: instruction,
  };
}

export function parseSandboxTaskCompilerProposal(
  value: string,
  maxCodeBytes = DEFAULT_SANDBOX_TASK_MAX_CODE_BYTES,
): SandboxTaskCompilerProposal {
  const normalized = value.trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    throw new Error("sandbox_task_compiler_invalid_json");
  }
  const parsed = compilerProposalSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("sandbox_task_compiler_invalid_schema");
  if (parsed.data.needsExecution) {
    validateSandboxTaskPython(parsed.data.code, maxCodeBytes);
  }
  return parsed.data;
}

export function compileSandboxTaskProposal(input: {
  instruction: string;
  proposal: SandboxTaskCompilerProposal;
}): CompiledSandboxTask | null {
  if (!input.proposal.needsExecution) return null;
  const encoded = Buffer.from(input.proposal.code, "utf8").toString("base64");
  return {
    summary: input.proposal.summary,
    command:
      `python -c "exec(__import__('base64').b64decode('${encoded}').decode('utf-8'))"`,
    metadata: {
      compilerVersion: SANDBOX_TASK_COMPILER_VERSION,
      instructionHash: sha256(input.instruction),
      codeHash: sha256(input.proposal.code),
      riskClass: "self_contained_compute",
    },
  };
}

export function validateSandboxTaskPython(
  code: string,
  maxCodeBytes = DEFAULT_SANDBOX_TASK_MAX_CODE_BYTES,
) {
  if (Buffer.byteLength(code, "utf8") > maxCodeBytes) {
    throw new Error("sandbox_task_compiler_code_too_large");
  }
  if (/[^\t\n\r\x20-\x7e\u0080-\u{10ffff}]/u.test(code)) {
    throw new Error("sandbox_task_compiler_control_character");
  }
  if (!/\bprint\s*\(/u.test(code)) {
    throw new Error("sandbox_task_compiler_stdout_required");
  }
  for (const line of code.split(/\r?\n/u)) {
    const fromImport = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/u)?.[1];
    const imports = line.match(/^\s*import\s+(.+)$/u)?.[1]
      ?.split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/u, 1)[0]) ?? [];
    for (const moduleName of [...(fromImport ? [fromImport] : []), ...imports]) {
      const root = moduleName?.split(".", 1)[0];
      if (!root || !allowedImportRoots.has(root)) {
        throw new Error("sandbox_task_compiler_import_not_allowed");
      }
    }
  }
  const forbidden = [
    /\b(?:eval|exec|compile|__import__|input|breakpoint|open)\s*\(/u,
    /\b(?:globals|locals|vars|getattr|setattr|delattr)\s*\(/u,
    /__/u,
    /\b(?:os|sys|subprocess|socket|requests|urllib|http|ftplib|smtplib|pathlib|shutil|tempfile|glob|ctypes|multiprocessing|threading)\b/u,
    /\b(?:pip|apt|apk|npm|yarn|pnpm)\s+(?:install|add)\b/iu,
    /\bwhile\s+True\s*:/u,
  ];
  if (forbidden.some((pattern) => pattern.test(code))) {
    throw new Error("sandbox_task_compiler_unsafe_code");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
