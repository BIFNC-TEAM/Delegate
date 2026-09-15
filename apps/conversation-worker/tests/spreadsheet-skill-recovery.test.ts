import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_SPREADSHEET_SKILL,
  compileBuiltinSpreadsheetRecovery,
  validateDeclaredAttachmentRead,
} from "../src/spreadsheet-skill-recovery";

const instructions = [
  "使用 Python 标准库 csv.DictReader 读取声明的 CSV 附件路径，不得根据文件名或文件大小推断内容。",
  "只处理 status == 'completed' 的行；净销售额严格计算为 int(quantity) * float(unit_price) - float(refund_amount)。",
  "写出文件后必须重新读取并核验表头、数据行、过滤条件和数值合计；核验失败时不得声明完成。",
  "用户要求缩小范围时，以最新要求覆盖旧范围并重新生成产物。",
].join("\n");

const trustedSkill = {
  slug: BUILTIN_SPREADSHEET_SKILL.id,
  version: BUILTIN_SPREADSHEET_SKILL.version,
  enabled: true,
  instructions,
  instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
  resources: [BUILTIN_SPREADSHEET_SKILL.resource],
};

const attachment = {
  id: "attachment-1",
  fileName: "orders.csv",
  mimeType: "text/csv",
  uri: "/workspace/inputs/orders.csv",
};

describe("built-in spreadsheet Skill evidence recovery", () => {
  it("requires a selected attachment and an actual file-read expression", () => {
    expect(validateDeclaredAttachmentRead({
      code: "print('rows,10000')",
      attachmentIds: [],
      attachments: [attachment],
    })).toEqual({ ok: false, reason: "sandbox_attachment_selection_missing" });
    expect(validateDeclaredAttachmentRead({
      code: "# /workspace/inputs/orders.csv\nprint('rows,10000')",
      attachmentIds: ["orders.csv"],
      attachments: [attachment],
    })).toEqual({ ok: false, reason: "sandbox_attachment_path_not_read" });
    expect(validateDeclaredAttachmentRead({
      code: "INPUT_PATH = '/workspace/inputs/orders.csv'\nwith open(INPUT_PATH) as source:\n    source.read()",
      attachmentIds: ["attachment-1"],
      attachments: [attachment],
    })).toEqual({ ok: true });
  });

  it("validates reads against the declared sandbox URI rather than the display name", () => {
    expect(validateDeclaredAttachmentRead({
      code: "with open('/workspace/inputs/attachment-safe.md') as source:\n    print(source.read())",
      attachmentIds: ["attachment-unicode"],
      attachments: [{
        id: "attachment-unicode",
        fileName: "欢迎.md",
        mimeType: "text/markdown",
        uri: "/workspace/inputs/attachment-safe.md",
      }],
    })).toEqual({ ok: true });
  });

  it("compiles a streaming summary without embedding golden result values", () => {
    const plan = compileBuiltinSpreadsheetRecovery({
      userText: "逐行按 quantity*unit_price-refund_amount 汇总，输出 metric,value 并交付 large-file-summary.csv",
      skills: [trustedSkill],
      attachments: [attachment],
    });

    expect(plan?.request).toMatchObject({
      language: "python",
      attachmentIds: ["attachment-1"],
      expectedOutputs: ["large-file-summary.csv"],
    });
    expect(plan?.request.code).toContain("csv.DictReader");
    expect(plan?.request.code).toContain("Decimal(row['quantity']) * Decimal(row['unit_price']) - Decimal(row['refund_amount'])");
    expect(plan?.request.code).toContain("/workspace/inputs/orders.csv");
    expect(plan?.request.code).not.toContain("10000");
    expect(plan?.request.code).not.toContain("100000");
  });

  it("compiles an explicit city filter into a data-derived CSV", () => {
    const plan = compileBuiltinSpreadsheetRecovery({
      userText: "只保留 city=深圳，按 quantity*unit_price-refund_amount 计算，输出 order_id,city,net_sales_cny 到 shenzhen-summary.csv",
      skills: [trustedSkill],
      attachments: [attachment],
    });

    expect(plan?.request.expectedOutputs).toEqual(["shenzhen-summary.csv"]);
    expect(plan?.request.code).toContain('TARGET_CITY = "深圳"');
    expect(plan?.request.code).toContain("row['city'].strip() != TARGET_CITY");
  });

  it("uses the collision-safe runtime URI instead of reconstructing the display filename", () => {
    const plan = compileBuiltinSpreadsheetRecovery({
      userText: "只保留 city=深圳，按 quantity*unit_price-refund_amount 计算，输出 order_id,city,net_sales_cny 到 shenzhen-summary.csv",
      skills: [trustedSkill],
      attachments: [{
        ...attachment,
        uri: "/workspace/inputs/attachment-collision-safe.csv",
      }],
    });

    expect(plan?.request.code).toContain("/workspace/inputs/attachment-collision-safe.csv");
    expect(plan?.request.code).not.toContain("/workspace/inputs/orders.csv");
  });

  it("fails closed for an untrusted release, ambiguous files, or an unspecified output", () => {
    const common = {
      userText: "按 quantity*unit_price-refund_amount 汇总并输出 metric,value",
      attachments: [attachment],
    };
    expect(compileBuiltinSpreadsheetRecovery({
      ...common,
      skills: [{ ...trustedSkill, instructionsSha256: "0".repeat(64) }],
    })).toBeUndefined();
    expect(compileBuiltinSpreadsheetRecovery({
      ...common,
      skills: [trustedSkill],
      attachments: [attachment, { ...attachment, id: "attachment-2", fileName: "other.csv", uri: "/workspace/inputs/other.csv" }],
    })).toBeUndefined();
    expect(compileBuiltinSpreadsheetRecovery({ ...common, skills: [trustedSkill] })).toBeUndefined();
  });
});
