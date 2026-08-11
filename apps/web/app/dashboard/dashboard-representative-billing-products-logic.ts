import type { Locale } from "@delegate/web-ui";

export type ProductKind = "SERVICE_PACKAGE" | "TIP";
export type HandoffAllowance = "NONE" | "LIMITED" | "UNLIMITED";
export type HandoffServiceLevel = "STANDARD" | "PRIORITY";

export type PriceTerms = {
  amountMinor: number;
  entitlementUnits: number;
  handoffAllowance: HandoffAllowance;
  handoffUnits: number | null;
  handoffServiceLevel: HandoffServiceLevel | null;
  handoffValidityDays: number | null;
};

export type ProductEditor =
  | {
      mode: "create";
      idempotencyKey: string;
      productKind: ProductKind;
      name: string;
      description: string;
      sortOrder: number;
      isRecommended: boolean;
      price: PriceTerms;
    }
  | {
      mode: "metadata";
      idempotencyKey: string;
      productKind: ProductKind;
      productId: string;
      expectedRevision: number;
      name: string;
      description: string;
      sortOrder: number;
      isRecommended: boolean;
    }
  | {
      mode: "price";
      idempotencyKey: string;
      productKind: ProductKind;
      productId: string;
      productName: string;
      expectedRevision: number;
      expectedActivePriceVersionId: string;
      price: PriceTerms;
    };

export function editorIsValid(editor: ProductEditor) {
  return Object.keys(editorValidationErrors(editor, "en")).length === 0;
}

export function editorRequiresPackageHandoff(editor: ProductEditor) {
  return editor.mode !== "metadata"
    && editor.productKind === "SERVICE_PACKAGE"
    && editor.price.handoffAllowance !== "NONE";
}

export function editorValidationErrors(editor: ProductEditor, locale: Locale) {
  const zh = locale === "zh";
  const errors: Record<string, string[]> = {};
  const add = (field: string, zhMessage: string, enMessage: string) => {
    errors[field] = [zh ? zhMessage : enMessage];
  };

  if (editor.mode !== "price") {
    const name = editor.name.trim();
    if (!name) {
      add("name", "请输入名称。", "Enter a name.");
    } else if (name.length > 80) {
      add("name", "名称不能超过 80 个字符。", "Name must not exceed 80 characters.");
    }
    if (
      !Number.isInteger(editor.sortOrder)
      || editor.sortOrder < 0
      || editor.sortOrder > 1_000_000
    ) {
      add("sortOrder", "排序必须是 0 到 1,000,000 的整数。", "Order must be an integer from 0 to 1,000,000.");
    }
    if (editor.description.length > 500) {
      add("description", "公开说明不能超过 500 个字符。", "Public description must not exceed 500 characters.");
    }
  }
  if (editor.mode === "metadata") return errors;

  const { price } = editor;
  if (
    !Number.isInteger(price.amountMinor)
    || price.amountMinor < 1
    || price.amountMinor > 1_000_000
  ) {
    add("amountMinor", "价格必须在 0.01 元到 10,000 元之间。", "Price must be between CNY 0.01 and CNY 10,000.");
  }
  if (editor.productKind === "TIP") return errors;
  if (
    !Number.isInteger(price.entitlementUnits)
    || price.entitlementUnits < 1
    || price.entitlementUnits > 10_000_000
  ) {
    add("entitlementUnits", "服务额度必须是 1 到 10,000,000 的整数。", "Credits must be an integer from 1 to 10,000,000.");
  }
  if (price.handoffAllowance === "NONE") return errors;
  if (!price.handoffServiceLevel) {
    add("handoffServiceLevel", "请选择人工服务级别。", "Select a handoff service level.");
  }
  if (
    !Number.isInteger(price.handoffValidityDays)
    || (price.handoffValidityDays ?? 0) < 1
    || (price.handoffValidityDays ?? 0) > 3_650
  ) {
    add("handoffValidityDays", "人工权益有效期必须是 1 到 3,650 天。", "Handoff validity must be from 1 to 3,650 days.");
  }
  if (price.handoffAllowance === "UNLIMITED") {
    if (price.handoffUnits !== null) {
      add("handoffUnits", "不限次权益不能同时配置次数。", "Unlimited handoff cannot also specify a use count.");
    }
    return errors;
  }
  if (
    !Number.isInteger(price.handoffUnits)
    || (price.handoffUnits ?? 0) < 1
    || (price.handoffUnits ?? 0) > 1_000_000
  ) {
    add("handoffUnits", "人工接管次数必须是 1 到 1,000,000 的整数。", "Handoff uses must be an integer from 1 to 1,000,000.");
  }
  return errors;
}
