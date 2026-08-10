import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const processor = readFileSync(
  new URL("../src/processor.ts", import.meta.url),
  "utf8",
);
const conversationPlatform = readFileSync(
  new URL(
    "../../../packages/web-data/src/conversation-platform.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("Matrix cross-channel memory command wiring", () => {
  it("issues and consumes a one-time challenge before model generation", () => {
    const commandBlock = processor.slice(
      processor.indexOf("const sharingCommand ="),
      processor.indexOf("if (item.delegationTerminalRecovery)"),
    );
    expect(commandBlock).toContain("resolveDeterministicContactMemorySharingCommand");
    expect(commandBlock).toContain("createContactMemorySharingChallenge");
    expect(commandBlock).toContain("readContactMemorySharingChallengeToken");
    expect(commandBlock).toContain("grantContactMemorySharingConsent");
    expect(commandBlock).toContain("revokeContactMemorySharingConsent");
    expect(commandBlock).toContain("contactMemorySharingConsentContractVersion");
    expect(commandBlock).toContain("sourceEventKey: `matrix:${item.inputMessageId}`");
    expect(commandBlock).toContain('sharingCommand === "INVALID_CONFIRM"');
    expect(commandBlock).toContain('sourceChannel: "MATRIX"');
    expect(commandBlock).toContain("completeInlineGenerationRun");
    expect(commandBlock).toContain("countUsage: false");
    expect(commandBlock).toContain("deliverGenerationOutput");
    expect(commandBlock).not.toContain("generateRepresentativeReply");
  });

  it("carries only provider-verified source coordinates into the worker claim", () => {
    const claim = conversationPlatform.slice(
      conversationPlatform.indexOf("export type ClaimedGenerationWorkItem"),
      conversationPlatform.indexOf("function buildDelegationRecoveryArtifactFileName"),
    );
    expect(claim).toContain("sourceSenderId?: string");
    expect(claim).toContain("privateChannelConnectionId?: string");
    expect(claim).toContain("run.inputMessage.senderId");
    expect(claim).toContain("activeBinding?.connectionId");
  });

  it("does not enqueue disclosure or consent commands for memory extraction", () => {
    const acceptance = conversationPlatform.slice(
      conversationPlatform.indexOf("export async function acceptInboundConversationMessage"),
      conversationPlatform.indexOf("export async function" , conversationPlatform.indexOf("export async function acceptInboundConversationMessage") + 30),
    );
    expect(acceptance).toContain(
      "else if (!resolveDeterministicContactMemorySharingCommand(text))",
    );
    expect(acceptance.indexOf("resolveDeterministicContactMemorySharingCommand"))
      .toBeLessThan(acceptance.indexOf("enqueueInboundMessageMemoryExtraction"));
  });
});
