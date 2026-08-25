import { describe, expect, it } from "vitest";

import {
  isDelegationTaskSessionContextValid,
  resolveDelegationTaskSessionDurationMinutes,
  resolveEffectiveDelegationFilesystemMode,
  resolveEffectiveDelegationNetworkMode,
} from "../src/delegation-task-context";

const input = {
  representativeId: "rep-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  generationRunId: "run-1",
  delegationTaskStepId: "step-1",
  requestedCapabilities: ["write"],
};

const task = {
  representativeId: "rep-1",
  contactId: "contact-1",
  originConversationId: "conversation-1",
  status: "READY",
  generationRuns: [{
    id: "run-1",
    status: "PROCESSING",
    delegationTaskStepId: "step-1",
  }],
  resourcePolicy: { allowedCapabilities: ["WRITE"] },
  steps: [{ id: "step-1", capability: "WRITE", status: "READY" }],
};

describe("delegation task compute session context", () => {
  it("accepts a matching task, step, generation, tenant, and capability", () => {
    expect(isDelegationTaskSessionContextValid(input, task)).toBe(true);
  });

  it.each([
    ["representative", { ...task, representativeId: "rep-2" }],
    ["contact", { ...task, contactId: "contact-2" }],
    ["conversation", { ...task, originConversationId: "conversation-2" }],
    ["generation", { ...task, generationRuns: [] }],
    ["newer generation", {
      ...task,
      generationRuns: [{
        id: "run-2",
        status: "PROCESSING",
        delegationTaskStepId: "step-1",
      }],
    }],
    ["run status", {
      ...task,
      generationRuns: [{
        id: "run-1",
        status: "COMPLETED",
        delegationTaskStepId: "step-1",
      }],
    }],
    ["run step", {
      ...task,
      generationRuns: [{
        id: "run-1",
        status: "PROCESSING",
        delegationTaskStepId: "step-2",
      }],
    }],
    ["step", {
      ...task,
      steps: [{ id: "step-2", capability: "WRITE", status: "READY" }],
    }],
    ["step capability", {
      ...task,
      steps: [{ id: "step-1", capability: "READ", status: "READY" }],
    }],
    ["step status", {
      ...task,
      steps: [{ id: "step-1", capability: "WRITE", status: "COMPLETED" }],
    }],
    ["resource policy", { ...task, resourcePolicy: { allowedCapabilities: ["READ"] } }],
    ["terminal status", { ...task, status: "COMPLETED" }],
  ])("rejects a mismatched %s", (_label, candidate) => {
    expect(isDelegationTaskSessionContextValid(input, candidate)).toBe(false);
  });

  it("uses the shorter representative or task duration ceiling", () => {
    expect(resolveDelegationTaskSessionDurationMinutes({
      representativeMaxSessionMinutes: 30,
      resourcePolicy: {
        allowedCapabilities: ["WRITE"],
        maxDurationMinutes: 5,
      },
    })).toBe(5);
    expect(resolveDelegationTaskSessionDurationMinutes({
      representativeMaxSessionMinutes: 5,
      resourcePolicy: {
        allowedCapabilities: ["WRITE"],
        maxDurationMinutes: 30,
      },
    })).toBe(5);
  });

  it("allows task network and filesystem modes to tighten but never relax", () => {
    expect(resolveEffectiveDelegationNetworkMode("allowlist", "FULL"))
      .toBe("allowlist");
    expect(resolveEffectiveDelegationNetworkMode("full", "NO_NETWORK"))
      .toBe("no_network");
    expect(resolveEffectiveDelegationFilesystemMode(
      "workspace_only",
      "EPHEMERAL_FULL",
    )).toBe("workspace_only");
    expect(resolveEffectiveDelegationFilesystemMode(
      "ephemeral_full",
      "READ_ONLY_WORKSPACE",
    )).toBe("read_only_workspace");
  });
});
