import { describe, expect, it } from "vitest";

import {
  ConversationIngressValidationError,
  validateInboundConversationPayload,
} from "../src/conversation-platform";

describe("conversation ingress validation", () => {
  it("normalizes safe attachment metadata", () => {
    expect(validateInboundConversationPayload({
      representativeSlug: "rep",
      conversationId: "conversation",
      text: "请看附件",
      clientMessageId: "message-1",
      attachments: [{
        fileName: "../brief.pdf",
        mimeType: "APPLICATION/PDF",
        sizeBytes: 512,
        externalUrl: "https://files.example.test/brief.pdf",
      }],
    })).toEqual([{
      fileName: "brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 512,
      externalUrl: "https://files.example.test/brief.pdf",
    }]);
  });

  it.each([
    ["unsupported MIME", { fileName: "tool.sh", mimeType: "text/x-shellscript", sizeBytes: 5, objectKey: "uploads/tool" }],
    ["unsafe URL", { fileName: "link.txt", mimeType: "text/plain", sizeBytes: 5, externalUrl: "javascript:alert(1)" }],
    ["oversized file", { fileName: "large.pdf", mimeType: "application/pdf", sizeBytes: 11 * 1024 * 1024, objectKey: "uploads/large" }],
  ])("rejects %s", (_label, attachment) => {
    expect(() => validateInboundConversationPayload({
      representativeSlug: "rep",
      conversationId: "conversation",
      text: "请看附件",
      clientMessageId: "message-1",
      attachments: [attachment],
    })).toThrow(ConversationIngressValidationError);
  });
});
