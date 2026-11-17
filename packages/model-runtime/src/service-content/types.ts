import { z } from "zod";
import type { ModelProvider } from "../types";

const codePoints = (max: number) => z.string().trim().refine(value => Array.from(value).length <= max);
export const serviceContentInputSchema = z.object({
  workFields: z.array(z.string().trim()).default([])
    .transform(values => [...new Set(values.filter(Boolean))])
    .pipe(z.array(codePoints(80)).max(20)),
  serviceContent: codePoints(500).default(""),
  language: z.enum(["zh", "en"]).default("zh"),
}).strict();
export type ServiceContentInput = z.input<typeof serviceContentInputSchema>;
export type ServiceContentResult = {
  status: "success" | "insufficient_input" | "empty_suggestion" | "invalid_input" | "timeout" | "model_failure";
  serviceContent: string;
  truncated: boolean;
  message?: string;
  attempts: { provider: ModelProvider; model: string; kind?: string }[];
};
