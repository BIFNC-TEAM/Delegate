import { describe, expect, it } from "vitest";
import { requiresKnowledgeSourceChange, knowledgeTextLimitMessage } from "@delegate/domain/knowledge-limits";
describe("knowledge failures requiring a new source", () => {
 it("blocks retry for current and previously saved text limits", () => {
  expect(requiresKnowledgeSourceChange(knowledgeTextLimitMessage(2_000_001))).toBe(true);
  expect(requiresKnowledgeSourceChange("笔记正文超过 400,000 字符。")).toBe(true);
  expect(requiresKnowledgeSourceChange("文件不能超过 150 MB。")).toBe(true);
 });
 it("keeps transient provider and network failures retryable", () => {
  expect(requiresKnowledgeSourceChange("MinerU 解析超时，请稍后重新处理。")).toBe(false);
  expect(requiresKnowledgeSourceChange("fetch failed")).toBe(false);
  expect(requiresKnowledgeSourceChange("索引处理失败，请重试。")).toBe(false);
 });
 it("does not block assets without failures", () => {
  expect(requiresKnowledgeSourceChange(null)).toBe(false);
  expect(requiresKnowledgeSourceChange(undefined)).toBe(false);
 });
});
