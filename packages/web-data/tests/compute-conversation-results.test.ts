import { describe, expect, it } from "vitest";

import { formatComputeOutcome } from "../src/compute-conversation-results";
import { renderPublicConversationMessageText } from "../src/conversation-platform";

describe("compute conversation results", () => {
  it("shows a downloadable file name without leaking sandbox paths, object keys, or document contents", () => {
    const text = formatComputeOutcome({
      outcome: "completed",
      artifacts: [{
        id: "artifact-1",
        kind: "file",
        summary: "/workspace/outputs/report-1ce03c47.md: # 年度销售总结\n内部正文",
        objectKey: "sandbox/session-1/outputs/report-1ce03c47.md",
        mimeType: "text/markdown",
        fileName: "report-1ce03c47.md",
      }],
      actualCredits: 5,
    });

    expect(text).toContain("已生成文件：report-1ce03c47.md");
    expect(text).toContain("消耗：5 credits");
    expect(text).not.toContain("/workspace");
    expect(text).not.toContain("sandbox/session-1");
    expect(text).not.toContain("内部正文");
  });

  it("keeps raw execution errors in the owner audit trail instead of exposing them publicly", () => {
    const text = formatComputeOutcome({
      outcome: "failed",
      failureReason: "command failed at /workspace/private/report.md with token=secret",
    });

    expect(text).toContain("详细原因已记录供代表所有者查看");
    expect(text).not.toContain("/workspace");
    expect(text).not.toContain("token=secret");
  });

  it("sanitizes legacy compute result messages when serving public conversation history", () => {
    const text = renderPublicConversationMessageText({
      text: "审批已通过，委托任务执行完成。\n\nfile: /workspace/outputs/report.md: # 私有正文",
      content: { kind: "compute_approval_result", outcome: "completed", actualCredits: 5 },
      attachments: [{ fileName: "report.md" }],
    });

    expect(text).toBe("审批已通过，委托任务执行完成。\n\n已生成文件：report.md\n\n消耗：5 credits");
    expect(text).not.toContain("/workspace");
    expect(text).not.toContain("私有正文");
  });
});
