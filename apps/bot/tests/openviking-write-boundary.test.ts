import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("Telegram generation ownership", () => {
  it("queues generation in the worker without a parallel legacy reply or recall path", () => {
    const source = readFileSync(new URL("../src/telegram-bot-runtime.ts", import.meta.url), "utf8");
    expect(source).toContain("acceptInboundConversationMessage(inboundInput)");
    for (const retired of ["generateRepresentativeReply", "createConversationPlan", "recallOpenVikingContext", "captureTurnToOpenViking"]) expect(source).not.toContain(retired);
    expect(existsSync(new URL("../src/openviking-runtime.ts", import.meta.url))).toBe(false);
  });
});
