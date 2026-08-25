import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260817180000_conversation_turn_plan_temporal_execution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

function model(name: string) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

describe("conversation planning persistence foundation", () => {
  it("persists plans, actions, authorization history, and delivery attempts", () => {
    expect(model("ConversationTurnPlan")).toContain("planSnapshot");
    expect(model("ConversationTurnPlan")).toContain("requestHash");
    expect(model("ConversationTurnPlan")).toContain("supersedesPlanId");
    expect(model("ConversationTurnPlan")).toContain("promptVersion");
    expect(model("ConversationTurnPlan")).toContain("capabilityCatalogHash");
    expect(model("ConversationTurnPlan")).toContain("planHash");
    expect(model("ConversationTurnPlan")).toContain("validationResult");
    expect(model("ConversationTurnPlan")).toContain("shadowMode");
    expect(model("ConversationPlanAction")).toContain("sideEffectClass");
    expect(model("ConversationPlanAction")).toContain("idempotencyKey");
    expect(model("ConversationPlanAction")).toContain("capabilityKey");
    expect(model("ConversationPlanAction")).toContain("capabilityVersion");
    expect(model("ConversationPlanAction")).toContain("capabilityDefinitionHash");
    expect(model("ConversationPlanAction")).toContain("argumentsHash");
    expect(model("ConversationPlanAction")).toContain("argumentProvenance");
    expect(model("ConversationPlanAction")).toContain("expectedOutputSchema");
    expect(model("ConversationPlanAction")).toContain("onFailure");
    expect(model("ActionAuthorizationDecision")).toContain("policySnapshotHash");
    expect(model("ActionAuthorizationDecision")).toContain("requestPayloadHash");
    expect(model("MessageDeliveryAttempt")).toContain("leaseExpiresAt");
    expect(model("MessageDeliveryAttempt")).toContain("idempotencyKey");
    expect(schema).toContain("PROVIDER_ACCEPTED");
    expect(schema).toContain("CONFIRMED");
    expect(schema).not.toMatch(/enum MessageDeliveryAttemptStatus[\s\S]*?\n\s+SENT\n/);
  });

  it("keeps the migration independent and adds the durable execution workflow kind", () => {
    expect(migration).toContain("CREATE TABLE \"ConversationTurnPlan\"");
    expect(migration).toContain("CREATE TABLE \"ConversationPlanAction\"");
    expect(migration).toContain("CREATE TABLE \"ActionAuthorizationDecision\"");
    expect(migration).toContain("CREATE TABLE \"MessageDeliveryAttempt\"");
    expect(migration).toContain("DELEGATION_EXECUTION");
    expect(migration).toContain("WAITING_SIGNAL");
    expect(migration).toContain("ConversationTurnPlan_generationRun_revision_key");
    expect(migration).toContain("ConversationTurnPlan_supersedesPlanId_fkey");
    expect(migration).toContain("PROVIDER_ACCEPTED");
  });
});
