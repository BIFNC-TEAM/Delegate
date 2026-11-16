import { z } from "zod";
import type { ModelProvider } from "../types";

export const faqSourceSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(180),
  text: z.string(),
});

export const faqSuggestionsInputSchema = z.object({
  representative: z.object({
    name: z.string().trim().min(1).max(180),
    description: z.string().max(2000),
  }),
  sources: z.array(faqSourceSchema).max(100),
  count: z.number().int().min(1).max(10).default(3),
  language: z.string().trim().min(1).max(40).default("中文"),
}).strict().refine((input) =>
  new Set(input.sources.map((source) => source.id)).size === input.sources.length
  && !input.sources.some((source) => source.id === "representative"),
);

export const faqSuggestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
  sourceIds: z.array(z.string()).min(1),
});

/** Input accepted by the internal FAQ generator; callers authorize sending all material. */
export type FaqSuggestionsInput = z.input<typeof faqSuggestionsInputSchema>;
export type FaqSuggestion = z.infer<typeof faqSuggestionSchema>;
export type FaqSourceStatus = {
  id: string;
  status: "complete" | "partial" | "unused" | "skipped";
  reason?: string;
};
export type FaqAttempt = {
  provider: ModelProvider;
  model: string;
  kind?: "timeout" | "retryable" | "invalid_output" | "non_retryable";
  status?: number;
};
export type FaqResult = {
  status:
  | "success"
  | "insufficient_material"
  | "no_usable_sources"
  | "invalid_input"
  | "invalid_output"
  | "no_valid_suggestions"
  | "model_failure"
  | "timeout";
  suggestions: FaqSuggestion[];
  sources: FaqSourceStatus[];
  attempts: FaqAttempt[];
  returnedCount: number;
  filteredCount: number;
  truncatedCount: number;
  warning?: string;
  reason?: string;
};
