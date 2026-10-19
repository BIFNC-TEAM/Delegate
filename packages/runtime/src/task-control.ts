

export function parseTaskControlCommand(text: string): { kind: "status" | "cancel"; runId?: string } | null {
  const value = text.trim().replace(/\s+/gu, " ");
  const explicit = value.match(/^[!\/](status|cancel)(?: ([A-Za-z0-9_-]{1,160}))?$/iu);
  if (explicit) return { kind: explicit[1]!.toLowerCase() as "status" | "cancel", ...(explicit[2] ? { runId: explicit[2] } : {}) };
  if (["查询当前状态", "查看当前状态"].includes(value)) return { kind: "status" };
  if (isConversationCancellationRequest(value)) return { kind: "cancel" };
  return null;
}



export function isConversationCancellationRequest(text: string) {
  return [
    "/cancel",
    "cancel",
    "cancel current task",
    "取消",
    "取消任务",
    "取消当前任务",
    "停止当前任务",
  ].includes(text.trim().toLowerCase());
}
