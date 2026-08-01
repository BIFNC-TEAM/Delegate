import type { Locale } from "@delegate/web-ui";

export type GovernedContextSyncOutcome =
  | "success"
  | "in_progress"
  | "idle"
  | "blocked_unpublished"
  | "blocked_service_setup"
  | "failed"
  | "disabled"
  | "attention_required";

export type GovernedContextSyncPresentation = {
  outcome: GovernedContextSyncOutcome;
  label: string;
  actionMessage: string;
};

export function getGovernedContextSyncPresentation(
  value: string,
  locale: Locale,
): GovernedContextSyncPresentation {
  const normalized = value.trim().toLowerCase();
  const zh = locale === "zh";

  if (
    normalized === "completed"
    || normalized === "success"
    || normalized === "succeeded"
    || normalized === "synced"
  ) {
    return {
      outcome: "success",
      label: zh ? "已同步" : "Synced",
      actionMessage: zh
        ? "当前已发布版本已同步。"
        : "The current released version has been synced.",
    };
  }

  if (normalized === "running" || normalized === "queued" || normalized === "pending") {
    return {
      outcome: "in_progress",
      label: zh ? "同步中" : "Syncing",
      actionMessage: zh
        ? "同步已经开始，完成后状态会自动更新。"
        : "Sync has started. The status will update when it finishes.",
    };
  }

  if (normalized === "blocked_unpublished") {
    return {
      outcome: "blocked_unpublished",
      label: zh ? "需要先发布" : "Publish required",
      actionMessage: zh
        ? "尚未同步：请先发布一个代表版本，再重新同步。"
        : "Nothing was synced. Release a representative version, then try again.",
    };
  }

  if (normalized === "blocked_missing_credentials") {
    return {
      outcome: "blocked_service_setup",
      label: zh ? "服务待配置" : "Service setup required",
      actionMessage: zh
        ? "尚未同步：检索服务尚未完成配置，请联系管理员后重试。"
        : "Nothing was synced. The retrieval service still needs administrator setup.",
    };
  }

  if (normalized === "failed" || normalized === "error") {
    return {
      outcome: "failed",
      label: zh ? "同步失败" : "Sync failed",
      actionMessage: zh
        ? "同步未完成，请稍后重试；公开回答仍使用上一次成功发布的内容。"
        : "Sync did not finish. Try again later; public replies still use the last successful release.",
    };
  }

  if (normalized === "disabled") {
    return {
      outcome: "disabled",
      label: zh ? "已关闭" : "Off",
      actionMessage: zh
        ? "同步未执行：已发布知识检索当前已关闭。"
        : "Nothing was synced because published-source retrieval is off.",
    };
  }

  if (normalized === "idle" || normalized === "never" || !normalized) {
    return {
      outcome: "idle",
      label: zh ? "等待同步" : "Awaiting sync",
      actionMessage: zh
        ? "尚未完成同步，请稍后重试。"
        : "No sync has completed yet. Try again later.",
    };
  }

  return {
    outcome: "attention_required",
    label: zh ? "需要检查" : "Needs attention",
    actionMessage: zh
      ? "同步状态需要检查，请稍后重试。"
      : "The sync status needs attention. Try again later.",
  };
}
