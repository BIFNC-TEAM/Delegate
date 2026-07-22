import { describe, expect, it } from "vitest";

import { isDelegationTaskSessionContextValid } from "../src/delegation-task-context";

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
  generationRuns: [{ id: "run-1" }],
  resourcePolicy: { allowedCapabilities: ["WRITE"] },
  steps: [{ id: "step-1", capability: "WRITE" }],
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
    ["step", { ...task, steps: [{ id: "step-2", capability: "WRITE" }] }],
    ["step capability", { ...task, steps: [{ id: "step-1", capability: "READ" }] }],
    ["resource policy", { ...task, resourcePolicy: { allowedCapabilities: ["READ"] } }],
    ["terminal status", { ...task, status: "COMPLETED" }],
  ])("rejects a mismatched %s", (_label, candidate) => {
    expect(isDelegationTaskSessionContextValid(input, candidate)).toBe(false);
  });
});
