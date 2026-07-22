import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");

function model(name: string) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

describe("delegation task aggregate schema", () => {
  it("captures task identity, version, objective, state, limits, and audit history", () => {
    const task = model("DelegationTask");
    expect(task).toContain("representativeVersionId");
    expect(task).toContain("objective");
    expect(task).toContain("desiredOutcome");
    expect(task).toContain("nextActionBy");
    expect(task).toContain("resourcePolicy");
    expect(task).toContain("externalEffects");
    expect(task).toContain("events");

    expect(model("DelegationTaskResourcePolicy")).toContain("maxDurationMinutes");
    expect(model("DelegationTaskResourcePolicy")).toContain("allowedCapabilities");
    expect(model("DelegationTaskDataGrant")).toContain("scopes");
    expect(model("DelegationTaskEvent")).toContain("eventHash");
    expect(model("DelegationTaskEvent")).toContain("previousHash");
  });

  it("links the task through execution, approval, workflow, billing, and outputs", () => {
    for (const name of [
      "Message",
      "GenerationRun",
      "ComputeSession",
      "ToolExecution",
      "ApprovalRequest",
      "Artifact",
      "Deliverable",
      "WorkflowRun",
      "LedgerEntry",
      "EventAudit",
    ]) {
      expect(model(name), `${name} should reference DelegationTask`).toContain("delegationTaskId");
    }
    expect(model("DelegationTaskOutput")).toContain("artifactId");
    expect(model("DelegationTaskOutput")).toContain("deliverableId");
    expect(model("DelegationTaskExternalEffect")).toContain("approvalRequestId");
  });
});
