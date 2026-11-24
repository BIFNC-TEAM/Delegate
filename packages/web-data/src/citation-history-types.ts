import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const derivedCitationHistorySchema = z.object({
  version: z.literal(1), formedAt: z.number().int().nonnegative(), byteBudget: z.number().int().nonnegative().max(512000), transcriptHash: hash,
  pairs: z.array(z.object({ runId: z.string(), inputMessageId: z.string(), outputMessageId: z.string(),
    inputHash: hash, outputHash: hash, annotationHash: hash, derivedHash: hash,
  }).strict()).max(8),
}).strict();
export type DerivedCitationHistoryProof = z.infer<typeof derivedCitationHistorySchema>;
export type CitationHistoryMessage = { id: string; role: "user" | "assistant"; text: string; timestamp: number };
export const CITATION_HISTORY_UNAVAILABLE = "〔此处历史内容的引用来源已不可用〕";
