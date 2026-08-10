import { MemoryUseSourceKind } from "@prisma/client";

import { prisma } from "./prisma";

export const generalModelAnswerSourceStatement =
  "来源说明：本回答未引用已授权知识或记忆，内容由通用模型生成。";

export const privateChannelSourceVerificationUnavailableStatement =
  "来源说明：暂时无法核验本次回答是否引用了已授权知识或记忆。为避免发送未经核验的内容，本次回答已被隐藏，请稍后重新提问。";

type PrivateChannelCitationFact = {
  title: string;
  memoryUseItem: {
    sourceKind: MemoryUseSourceKind;
    citedAt: Date | null;
    useRun: { generationRunId: string };
  } | null;
};

/**
 * Build the transport-only text for a Matrix or Telegram generation reply.
 *
 * The persisted Message remains the source-of-truth response body. This
 * function deliberately recomputes its footer from the finalized GenerationRun
 * and MessageCitation ledger on every delivery attempt, so retries cannot
 * inherit a stale or client-provided source claim.
 */
export async function renderPrivateChannelGenerationDeliveryText(input: {
  generationRunId: string;
  outputMessageId: string;
  text: string;
}) {
  try {
    const run = await prisma.generationRun.findFirst({
      where: {
        id: input.generationRunId,
        outputMessageId: input.outputMessageId,
      },
      select: {
        id: true,
        contextSnapshot: true,
        outputMessage: {
          select: {
            id: true,
            text: true,
            citations: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                title: true,
                memoryUseItem: {
                  select: {
                    sourceKind: true,
                    citedAt: true,
                    useRun: { select: { generationRunId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (
      !run?.outputMessage
      || run.id !== input.generationRunId
      || run.outputMessage.id !== input.outputMessageId
      || run.outputMessage.text !== input.text
    ) {
      return privateChannelSourceVerificationUnavailableStatement;
    }

    const runtimeOutcome = readVerifiedRuntimeOutcome(run.contextSnapshot);
    if (!runtimeOutcome) {
      return privateChannelSourceVerificationUnavailableStatement;
    }

    return renderPrivateChannelAnswerSourceFooter({
      text: run.outputMessage.text,
      modelGenerated: runtimeOutcome === "model",
      citations: run.outputMessage.citations.filter(
        (citation) =>
          citation.memoryUseItem?.citedAt
          && citation.memoryUseItem.useRun.generationRunId === run.id,
      ),
    });
  } catch {
    return privateChannelSourceVerificationUnavailableStatement;
  }
}

export function renderPrivateChannelAnswerSourceFooter(input: {
  text: string;
  modelGenerated: boolean;
  citations: PrivateChannelCitationFact[];
}) {
  const sources = uniqueStable(
    input.citations.flatMap((citation) => {
      const memoryUseItem = citation.memoryUseItem;
      if (!memoryUseItem?.citedAt) return [];
      if (memoryUseItem.sourceKind === MemoryUseSourceKind.CONTACT_MEMORY) {
        return ["本人历史信息"];
      }
      if (
        memoryUseItem.sourceKind
        === MemoryUseSourceKind.REPRESENTATIVE_EXPERIENCE
      ) {
        return ["代表经验"];
      }
      if (memoryUseItem.sourceKind === MemoryUseSourceKind.PUBLIC_KNOWLEDGE) {
        return [`公开知识：${safePrivateChannelKnowledgeTitle(citation.title)}`];
      }
      return [];
    }),
  );
  if (sources.length > 0) {
    return `${input.text}\n\n——\n来源：${sources.join("；")}`;
  }
  if (input.modelGenerated) {
    return `${input.text}\n\n——\n${generalModelAnswerSourceStatement}`;
  }
  return input.text;
}

function readVerifiedRuntimeOutcome(value: unknown): "model" | "fallback" | null {
  if (!isRecord(value)) return null;
  const outcome = value.runtimeOutcome;
  if (
    !isRecord(outcome)
    || outcome.version !== 1
    || (outcome.mode !== "model" && outcome.mode !== "fallback")
  ) {
    return null;
  }
  return outcome.mode;
}

function safePrivateChannelKnowledgeTitle(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !normalized
    || normalized.length > 120
    || /(?:[a-z][a-z0-9+.-]*:\/\/|viking:)/iu.test(normalized)
    || /(?:^|[\s._:/-])(?:uri|score|layer|session(?:[\s._-]*id)?)(?:$|[\s._:/-])/iu.test(
      normalized,
    )
  ) {
    return "已发布知识";
  }
  return normalized;
}

function uniqueStable(values: string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
