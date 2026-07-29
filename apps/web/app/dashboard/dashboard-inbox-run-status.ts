import type { ConversationDetailSnapshot } from "@delegate/web-data";
import type { Locale } from "@delegate/web-ui";

type GenerationRun = ConversationDetailSnapshot["runs"][number];

export type GenerationRunPresentation = {
  label: string;
  detail: string;
  markerClass: string;
};

export function formatGenerationRunPresentation(
  run: GenerationRun,
  locale: Locale,
): GenerationRunPresentation {
  const zh = locale === "zh";
  if (run.runtimeOutcome?.mode === "fallback") {
    const detail = run.runtimeOutcome.fallbackReason === "model_unavailable"
      ? (zh
          ? "模型服务当前不可用；请检查配置后重新测试。"
          : "The model service was unavailable; check its configuration before testing again.")
      : run.runtimeOutcome.fallbackReason === "provider_failed"
        ? (zh
            ? "模型请求未完成；可稍后重新测试。"
            : "The model request did not complete; try again later.")
        : run.runtimeOutcome.fallbackReason === "policy_fallback"
          ? (zh
              ? "当前回答路径未使用模型。"
              : "This response path did not use the model.")
          : (zh
              ? "模型未参与本次生成。"
              : "The model was not used for this run.");
    return {
      label: zh ? "已发送基础回复" : "Basic reply sent",
      detail,
      markerClass: "is-waiting_human",
    };
  }

  const labels: Record<string, [string, string]> = {
    queued: ["排队中", "Queued"],
    processing: ["生成中", "Processing"],
    waiting_approval: ["等待审批", "Waiting approval"],
    waiting_human: ["等待人工", "Waiting human"],
    completed: ["已完成", "Completed"],
    failed: ["失败", "Failed"],
    canceled: ["已取消", "Canceled"],
  };
  const label = labels[run.status] || [run.status, run.status];
  return {
    label: zh ? label[0] : label[1],
    detail: run.model || (zh ? "模型待定" : "Model pending"),
    markerClass: `is-${run.status}`,
  };
}
