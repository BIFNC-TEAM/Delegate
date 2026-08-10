import { MemoryUseSourceKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationRun: { findFirst: vi.fn() },
}));

vi.mock("../src/prisma", () => ({
  prisma: { generationRun: mocks.generationRun },
}));

import {
  generalModelAnswerSourceStatement,
  privateChannelSourceVerificationUnavailableStatement,
  renderPrivateChannelAnswerSourceFooter,
  renderPrivateChannelGenerationDeliveryText,
} from "../src/private-channel-answer-source";

describe("private channel answer source footer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only authoritative source categories and safe public titles", () => {
    const citedAt = new Date("2026-08-06T10:00:00.000Z");

    const rendered = renderPrivateChannelAnswerSourceFooter({
      text: "答案正文",
      modelGenerated: true,
      citations: [
        citation(MemoryUseSourceKind.PUBLIC_KNOWLEDGE, "世界地理 FAQ", citedAt),
        citation(MemoryUseSourceKind.CONTACT_MEMORY, "不应泄露的联系人正文", citedAt),
        citation(
          MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE,
          "旧版内部标签",
          citedAt,
        ),
        citation(MemoryUseSourceKind.CONTACT_MEMORY, "重复联系人正文", citedAt),
      ],
    });

    expect(rendered).toBe(
      "答案正文\n\n——\n来源：公开知识：世界地理 FAQ；本人历史信息；代表经验",
    );
    expect(rendered).not.toContain("不应泄露的联系人正文");
    expect(rendered).not.toContain("旧版内部标签");
  });

  it.each([
    "viking://resources/private/asset.md",
    "FAQ session_id abc-123",
    "FAQ score 0.99",
    "FAQ layer L2",
  ])("replaces unsafe technical knowledge title %s", (title) => {
    const rendered = renderPrivateChannelAnswerSourceFooter({
      text: "答案正文",
      modelGenerated: true,
      citations: [
        citation(
          MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
          title,
          new Date("2026-08-06T10:00:00.000Z"),
        ),
      ],
    });

    expect(rendered).toBe(
      "答案正文\n\n——\n来源：公开知识：已发布知识",
    );
    expect(rendered).not.toContain(title);
  });

  it("discloses a general-model answer only when the persisted outcome is model", () => {
    expect(renderPrivateChannelAnswerSourceFooter({
      text: "模型答案",
      modelGenerated: true,
      citations: [],
    })).toBe(`模型答案\n\n——\n${generalModelAnswerSourceStatement}`);

    expect(renderPrivateChannelAnswerSourceFooter({
      text: "确定性降级答案",
      modelGenerated: false,
      citations: [],
    })).toBe("确定性降级答案");
  });

  it("recomputes from the bound run, output and cited ledger facts", async () => {
    const citedAt = new Date("2026-08-06T10:00:00.000Z");
    mocks.generationRun.findFirst.mockResolvedValue({
      id: "run-1",
      contextSnapshot: {
        runtimeOutcome: { version: 1, mode: "model" },
      },
      outputMessage: {
        id: "output-1",
        text: "持久化正文",
        citations: [
          {
            ...citation(
              MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
              "授权资料",
              citedAt,
            ),
            memoryUseItem: {
              sourceKind: MemoryUseSourceKind.PUBLIC_KNOWLEDGE,
              citedAt,
              useRun: { generationRunId: "run-1" },
            },
          },
          {
            ...citation(
              MemoryUseSourceKind.CONTACT_MEMORY,
              "另一个运行的引用",
              citedAt,
            ),
            memoryUseItem: {
              sourceKind: MemoryUseSourceKind.CONTACT_MEMORY,
              citedAt,
              useRun: { generationRunId: "run-other" },
            },
          },
          {
            ...citation(
              MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE,
              "尚未真正引用",
              null,
            ),
            memoryUseItem: {
              sourceKind: MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE,
              citedAt: null,
              useRun: { generationRunId: "run-1" },
            },
          },
        ],
      },
    });

    await expect(renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-1",
      outputMessageId: "output-1",
      text: "持久化正文",
    })).resolves.toBe(
      "持久化正文\n\n——\n来源：公开知识：授权资料",
    );
    expect(mocks.generationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", outputMessageId: "output-1" },
      }),
    );
  });

  it("hides the answer without a matching persisted run and output", async () => {
    mocks.generationRun.findFirst.mockResolvedValue(null);

    await expect(renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-missing",
      outputMessageId: "output-missing",
      text: "持久化正文",
    })).resolves.toBe(privateChannelSourceVerificationUnavailableStatement);
  });

  it("hides the answer when the authoritative runtime outcome is malformed", async () => {
    mocks.generationRun.findFirst.mockResolvedValue({
      id: "run-unknown",
      contextSnapshot: { runtimeOutcome: { version: 2, mode: "model" } },
      outputMessage: {
        id: "output-unknown",
        text: "不得发送的未核验正文",
        citations: [],
      },
    });

    await expect(renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-unknown",
      outputMessageId: "output-unknown",
      text: "不得发送的未核验正文",
    })).resolves.toBe(privateChannelSourceVerificationUnavailableStatement);
  });

  it("hides the answer when the authoritative source ledger cannot be read", async () => {
    mocks.generationRun.findFirst.mockRejectedValue(
      new Error("source ledger temporarily unavailable"),
    );

    const rendered = await renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-db-error",
      outputMessageId: "output-db-error",
      text: "不得发送的未核验正文",
    });

    expect(rendered).toBe(privateChannelSourceVerificationUnavailableStatement);
    expect(rendered).not.toContain("不得发送的未核验正文");
  });

  it("preserves a verified deterministic fallback without a model-source footer", async () => {
    mocks.generationRun.findFirst.mockResolvedValue({
      id: "run-fallback",
      contextSnapshot: {
        runtimeOutcome: { version: 1, mode: "fallback" },
      },
      outputMessage: {
        id: "output-fallback",
        text: "已核验的确定性降级答复",
        citations: [],
      },
    });

    await expect(renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-fallback",
      outputMessageId: "output-fallback",
      text: "已核验的确定性降级答复",
    })).resolves.toBe("已核验的确定性降级答复");
  });

  it("hides a caller body that differs from the authoritative output message", async () => {
    mocks.generationRun.findFirst.mockResolvedValue({
      id: "run-mismatch",
      contextSnapshot: {
        runtimeOutcome: { version: 1, mode: "model" },
      },
      outputMessage: {
        id: "output-mismatch",
        text: "权威持久化正文",
        citations: [],
      },
    });

    await expect(renderPrivateChannelGenerationDeliveryText({
      generationRunId: "run-mismatch",
      outputMessageId: "output-mismatch",
      text: "调用方注入的不同正文",
    })).resolves.toBe(privateChannelSourceVerificationUnavailableStatement);
  });
});

function citation(
  sourceKind: MemoryUseSourceKind,
  title: string,
  citedAt: Date | null,
) {
  return {
    title,
    memoryUseItem: {
      sourceKind,
      citedAt,
      useRun: { generationRunId: "run-1" },
    },
  };
}
