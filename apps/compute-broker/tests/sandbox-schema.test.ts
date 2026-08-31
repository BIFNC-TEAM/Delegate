import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");

function modelBlock(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? "";
}

describe("per-user sandbox schema", () => {
  it("keeps one sandbox identity per representative/contact/conversation scope", () => {
    const block = modelBlock("SandboxIdentity");

    expect(block).toMatch(/\brepresentativeId\s+String\b/);
    expect(block).toMatch(/\bcontactId\s+String\b/);
    expect(block).toMatch(/\bscopeKey\s+String\b/);
    expect(block).toContain("@@unique([representativeId, contactId, scopeKey])");
    expect(block).toMatch(/\blifecycleEpoch\s+Int\s+@default\(1\)/);
    expect(schema).toMatch(/enum SandboxProviderKind \{[\s\S]*?TENCENT[\s\S]*?\}/);
  });

  it("keeps compute sessions as execution records with an optional sandbox lease", () => {
    const block = modelBlock("ComputeSession");

    expect(block).toContain("sandboxLeaseId");
    expect(block).toMatch(/\bsandboxLease\s+SandboxLease\?/);
    expect(block).toMatch(/\brepresentativeVersionId\s+String\?/);
    expect(block).toMatch(
      /\brepresentativeVersion\s+RepresentativeVersion\?/,
    );
    expect(block).toMatch(/\bruntimeClass\s+SandboxRuntimeClass/);
  });

  it("lets browser sessions migrate to sandbox identity without breaking compute-session lookup", () => {
    const block = modelBlock("BrowserSession");

    expect(block).toContain("computeSessionId    String");
    expect(block).toContain("sandboxIdentityId");
    expect(block).toContain("sandboxLeaseId");
  });

  it("persists provider creation attempts with unique idempotency coordinates", () => {
    const block = modelBlock("SandboxProviderOperation");

    expect(block).toContain("creationKey");
    expect(block).toContain("SandboxProviderOperationState");
    expect(block).toContain("@@unique([sandboxLeaseId, attemptNumber, operation])");
  });
});
