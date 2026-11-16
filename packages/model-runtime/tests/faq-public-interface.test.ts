import { expect, it } from "vitest";
import { generateFaqSuggestions, decideFaqSuggestion } from "@delegate/model-runtime";
import type { FaqSuggestionsInput, FaqResult, FaqSuggestion } from "@delegate/model-runtime";

it("exports callable FAQ functions and types from the package", async () => {
  const input: FaqSuggestionsInput = { representative: { name: "示例", description: "" }, sources: [] };
  const result: FaqResult = await generateFaqSuggestions(input);
  const suggestion: FaqSuggestion = { question: "问题", answer: "回答", sourceIds: ["representative"] };
  expect(result.status).toBe("no_usable_sources");
  expect(decideFaqSuggestion(suggestion, true)).toEqual({ accepted: true, faq: suggestion });
});
