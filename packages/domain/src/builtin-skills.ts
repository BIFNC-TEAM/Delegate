import type { SkillPack } from "./schema";

export const spreadsheetAnalysisSkillInstructions = [
  "使用 Python 标准库 csv 模块读取已声明的 CSV 附件路径；除非运行环境已验证依赖可用，否则不要依赖 pandas、polars 等可选包。",
  "先读取表头和数据行，再根据用户要求选择分组维度、排序指标和升降序；字段含义不明确时只补问一个必要问题。",
  "数值计算必须来自实际行数据，并明确采用的字段、聚合方式和排序方向；不得根据文件名、大小或示例推断结果。",
  "输出排名时保留原始标识和实际指标值；需要交付文件时打印最终文件内容到 stdout，并在声明完成前核验表头和行数。",
].join("\n");

export const spreadsheetAnalysisSkillInstructionsSha256 =
  "4f6ca29ba9636c9a175fc47922fe77e275013d3f24567d3656cd2bf302715d1c";

export const builtinSpreadsheetAnalysisSkill = {
  id: "pack_builtin_spreadsheet_analysis",
  slug: "spreadsheet-analysis",
  displayName: "Spreadsheet Analysis",
  source: "builtin",
  summary: "CSV、Excel、表格和销售数据的读取、汇总、排名与结果核验。",
  version: "1.0.0",
  sourceUrl: "https://delegate.local/skill-packs/spreadsheet-analysis",
  verificationTier: "delegate-platform",
  capabilityTags: ["csv", "spreadsheet", "excel", "data-analysis", "ranking", "sandbox"],
  executesCode: true,
  instructions: spreadsheetAnalysisSkillInstructions,
  instructionsSha256: spreadsheetAnalysisSkillInstructionsSha256,
  resources: ["skill://builtin/spreadsheet-analysis/1.0.0"],
  enabled: true,
  installStatus: "installed",
} satisfies SkillPack;

export const builtinSkillCatalog = [builtinSpreadsheetAnalysisSkill] as const;
