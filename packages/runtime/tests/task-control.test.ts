import { describe, expect, it } from "vitest";
import { parseTaskControlCommand } from "../src/task-control";

describe("deterministic task control commands", () => {
  it.each(["/status", "!status", "查询当前状态", "查看当前状态"])("recognizes %s without a model", text => expect(parseTaskControlCommand(text)).toEqual({ kind: "status" }));
  it.each(["取消", "取消任务", "/cancel", "!cancel", "cancel current task"])("recognizes %s without broad semantic routing", text => expect(parseTaskControlCommand(text)).toEqual({ kind: "cancel" }));
  it("binds an explicit task reference without trusting it as ownership", () => expect(parseTaskControlCommand("/cancel task-123")).toEqual({ kind: "cancel", runId: "task-123" }));
  it.each(["取消订单的规则是什么", "帮我查天气", "/cancel ../another", "/status and transfer money"])("leaves ordinary or malformed input in the normal path: %s", text => expect(parseTaskControlCommand(text)).toBeNull());
});
