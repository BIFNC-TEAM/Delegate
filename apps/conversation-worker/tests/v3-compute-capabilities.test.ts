import { describe, expect, it, vi } from "vitest";

import type { ComputeExecutionRequest } from "@delegate/runtime";

import {
  buildV3ComputeCapabilityDefinitions,
  compileV3NaturalTaskExecutionRequest,
  isNaturalSandboxTaskEnabled,
} from "../src/v3-compute-capabilities";

describe("V3 natural sandbox task bridge", () => {
  it("publishes compute.task without changing explicit compute.exec", () => {
    const compute = {
      enabled: true,
      capabilityModes: {
        exec: "ask",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
      } as const,
    };
    const enabledDefinitions = buildV3ComputeCapabilityDefinitions(compute, true);
    const enabled = enabledDefinitions.find((definition) => definition.key === "compute.task");
    const direct = enabledDefinitions.find((definition) => definition.key === "compute.exec");
    const disabled = buildV3ComputeCapabilityDefinitions(compute, false)
      .find((definition) => definition.key === "compute.task");

    expect(enabled).toMatchObject({
      version: "1",
      inputSchema: { required: ["instruction"] },
      effect: { mutation: "write" },
      idempotency: "requires_key",
      semantics: { operations: ["answer", "create"] },
    });
    expect(direct).toMatchObject({
      version: "1",
      inputSchema: { required: ["command"] },
    });
    expect(disabled).toBeUndefined();
    expect(isNaturalSandboxTaskEnabled({
      naturalLanguageEnabled: true,
      networkMode: "NO_NETWORK",
      filesystemMode: "EPHEMERAL_FULL",
    })).toBe(true);
    expect(isNaturalSandboxTaskEnabled({
      naturalLanguageEnabled: true,
      networkMode: "FULL",
      filesystemMode: "EPHEMERAL_FULL",
    })).toBe(false);
  });

  it("compiles a grounded instruction into a server-built command payload", async () => {
    const compiler = vi.fn(async () => ({
      ok: true as const,
      provider: "openai",
      model: "gpt-test",
      task: {
        summary: "calculate",
        command: "python -c \"print(55)\"",
        metadata: {
          compilerVersion: "sandbox-task-compiler.v1" as const,
          instructionHash: "a".repeat(64),
          codeHash: "b".repeat(64),
          riskClass: "self_contained_compute" as const,
        },
      },
    }));
    const result = await compileV3NaturalTaskExecutionRequest({
      request: buildRequest({ instruction: "计算 1 到 10 的和" }),
      enabled: true,
      compiler,
    });

    expect(compiler).toHaveBeenCalledWith({ instruction: "计算 1 到 10 的和" });
    expect(result.payload).toEqual({
      command: "python -c \"print(55)\"",
      compiledTask: expect.objectContaining({
        compilerVersion: "sandbox-task-compiler.v1",
        riskClass: "self_contained_compute",
        compilerProvider: "openai",
        compilerModel: "gpt-test",
      }),
    });
    expect(result.argumentsHash).toBe("arguments-hash");
  });

  it("leaves explicit non-task Compute requests unchanged", async () => {
    const request = buildRequest({ command: "pwd" });
    await expect(compileV3NaturalTaskExecutionRequest({
      request,
      enabled: false,
    })).resolves.toBe(request);
  });

  it.each([
    {
      name: "disabled",
      enabled: false,
      compiler: undefined,
      code: "disabled",
    },
    {
      name: "compiler failure",
      enabled: true,
      compiler: async () => ({ ok: false as const, reason: "failed", state: "ready" }),
      code: "failed",
    },
    {
      name: "compiler decline",
      enabled: true,
      compiler: async () => ({ ok: true as const, task: null, reason: "unsupported" }),
      code: "declined",
    },
  ])("fails closed when task compilation is $name", async ({ enabled, compiler, code }) => {
    await expect(compileV3NaturalTaskExecutionRequest({
      request: buildRequest({ instruction: "访问网络" }),
      enabled,
      ...(compiler ? { compiler } : {}),
    })).rejects.toEqual(expect.objectContaining({ code }));
  });
});

function buildRequest(payload: Record<string, unknown>): ComputeExecutionRequest {
  return {
    executor: "compute",
    capability: "exec",
    payload,
    planId: "plan-1",
    planRevision: 1,
    executionEpoch: 1,
    actionId: "action-1",
    generationRunId: "run-1",
    capabilityKey: "compute.task",
    capabilityVersion: "1",
    capabilityDefinitionHash: "definition-hash",
    argumentsHash: "arguments-hash",
    idempotencyKey: "idempotency-key",
  };
}
