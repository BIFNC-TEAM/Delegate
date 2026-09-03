import { describe, expect, it } from "vitest";

import {
  buildSandboxTaskCompilerPrompt,
  compileSandboxTaskProposal,
  parseSandboxTaskCompilerProposal,
  validateSandboxTaskPython,
} from "../src/sandbox-task-compiler";

describe("sandbox task compiler", () => {
  it("parses and compiles a bounded self-contained Python task", () => {
    const instruction = "计算 1 到 10 的平方和";
    const proposal = parseSandboxTaskCompilerProposal(JSON.stringify({
      needsExecution: true,
      summary: "计算平方和",
      language: "python",
      riskClass: "self_contained_compute",
      code: "values = [n * n for n in range(1, 11)]\nprint(sum(values))",
    }));
    const task = compileSandboxTaskProposal({ instruction, proposal });

    expect(task).toMatchObject({
      summary: "计算平方和",
      metadata: {
        compilerVersion: "sandbox-task-compiler.v1",
        riskClass: "self_contained_compute",
      },
    });
    expect(task?.command).toMatch(/^python -c "exec\(__import__\('base64'\)/u);
    expect(task?.metadata.instructionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(task?.metadata.codeHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts an explicit no-execution result", () => {
    const proposal = parseSandboxTaskCompilerProposal(JSON.stringify({
      needsExecution: false,
      reason: "需要读取附件",
    }));
    expect(compileSandboxTaskProposal({ instruction: "分析附件", proposal })).toBeNull();
  });

  it.each([
    "import socket\nprint('x')",
    "import os\nprint(os.environ)",
    "from pathlib import Path\nprint(Path('/tmp'))",
    "open('secret.txt').read()\nprint('x')",
    "print(eval('1 + 1'))",
    "print(__import__('math'))",
    "import subprocess\nprint(subprocess.run(['id']))",
    "while True:\n    print('x')",
  ])("rejects unsafe Python: %s", (code) => {
    expect(() => validateSandboxTaskPython(code)).toThrow(/sandbox_task_compiler_/u);
  });

  it("rejects unapproved imports, missing stdout, control characters, and excessive code", () => {
    expect(() => validateSandboxTaskPython("import pandas\nprint('x')"))
      .toThrow("sandbox_task_compiler_import_not_allowed");
    expect(() => validateSandboxTaskPython("result = 1 + 1"))
      .toThrow("sandbox_task_compiler_stdout_required");
    expect(() => validateSandboxTaskPython("print('x')\u0000"))
      .toThrow("sandbox_task_compiler_control_character");
    expect(() => validateSandboxTaskPython(`print('${"x".repeat(100)}')`, 20))
      .toThrow("sandbox_task_compiler_code_too_large");
  });

  it("rejects malformed JSON and schema drift", () => {
    expect(() => parseSandboxTaskCompilerProposal("not json"))
      .toThrow("sandbox_task_compiler_invalid_json");
    expect(() => parseSandboxTaskCompilerProposal(JSON.stringify({
      needsExecution: true,
      language: "javascript",
      summary: "bad",
      riskClass: "self_contained_compute",
      code: "print('x')",
    }))).toThrow("sandbox_task_compiler_invalid_schema");
  });

  it("builds a bounded prompt that prohibits external effects", () => {
    const prompt = buildSandboxTaskCompilerPrompt("计算质数", 4096);
    expect(prompt.input).toBe("计算质数");
    expect(prompt.instructions).toContain("below 4096 bytes");
    expect(prompt.instructions).toContain("Do not read or write files");
    expect(prompt.instructions).toContain("access networks or URLs");
  });
});
