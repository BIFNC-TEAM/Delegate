import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createWorkspaceAuditCsvStream,
  escapeAuditCsvCell,
  serializeWorkspaceAuditCsvRow,
} from "../app/dashboard/dashboard-audit-csv";
import { auditEventLabel } from "../app/dashboard/dashboard-audit-labels";

const source = readFileSync(new URL("../app/dashboard/dashboard-audit-logs.tsx", import.meta.url), "utf8");

describe("dashboard skill audit log", () => {
  it("loads governed workspace events and supports filtering and export", () => {
    expect(source).toContain("/api/dashboard/audit?");
    expect(source).toContain("setEventType");
    expect(source).toContain("exportCsv");
    expect(source).toContain('parameters.set("cursor", cursor)');
    expect(source).toContain("snapshot?.page.hasMore");
    expect(source).toContain("Export all matches");
    expect(source).not.toContain("visibleEvents");
  });

  it("states the unified audit coverage and sensitive-payload boundary", () => {
    expect(source).toContain("统一查看技能、发布、审批、钱包、工具、工作流与会话事件");
    expect(source).toContain("without exposing sensitive payloads");
    expect(source).toContain("白名单元数据");
  });

  it("neutralizes formula prefixes and leading control characters in CSV exports", () => {
    expect(escapeAuditCsvCell("=1+1")).toBe("\"'=1+1\"");
    expect(escapeAuditCsvCell("\t=1+1")).toBe("\"'\t=1+1\"");
    expect(escapeAuditCsvCell("\r@SUM(A1)")).toBe("\"'\r@SUM(A1)\"");
    expect(escapeAuditCsvCell("ordinary")).toBe("\"ordinary\"");
  });

  it("serializes normalized fields and allowlisted metadata without the raw payload", () => {
    const row = serializeWorkspaceAuditCsvRow({
      id: "event-1",
      type: "skill_installed",
      category: "skills",
      representativeSlug: "delegate",
      representativeName: "Delegate",
      actor: "=HYPERLINK(\"https://invalid\")",
      summary: "skill installed",
      resource: { kind: "skill_install", id: "install-1" },
      traceId: null,
      anomaly: false,
      metadata: { status: "ACTIVE" },
      createdAt: "2026-07-23T16:00:00.000Z",
    });
    expect(row).toContain("\"'=HYPERLINK(\"\"https://invalid\"\")\"");
    expect(row).toContain("\"{\"\"status\"\":\"\"ACTIVE\"\"}\"");
    expect(row).not.toContain("event-1");
  });

  it("pulls CSV rows on demand and closes the source iterator when canceled", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const event = {
      id: "event-1",
      type: "skill_installed",
      category: "skills" as const,
      representativeSlug: "delegate",
      representativeName: "Delegate",
      actor: null,
      summary: "skill installed",
      resource: null,
      traceId: null,
      anomaly: false,
      metadata: {},
      createdAt: "2026-07-23T16:00:00.000Z",
    };
    const events = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            return { done: false as const, value: event };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const reader = createWorkspaceAuditCsvStream(events).getReader();

    expect(nextCalls).toBe(0);
    const header = await reader.read();
    expect(new TextDecoder().decode(header.value)).toContain("event_type");
    expect(nextCalls).toBe(0);
    const firstRow = await reader.read();
    expect(new TextDecoder().decode(firstRow.value)).toContain("skill_installed");
    expect(nextCalls).toBe(1);
    await reader.cancel();
    expect(returnCalls).toBe(1);
    expect(nextCalls).toBe(1);
  });

  it("labels recent activity as a rolling 24-hour window", () => {
    expect(source).toContain("最近 24 小时");
    expect(source).toContain("Rolling window, independent of server timezone");
    expect(source).toContain("metrics.last24Hours");
  });

  it("localizes common workspace audit events instead of exposing raw enum names", () => {
    expect(auditEventLabel("approval_resolved", "zh")).toBe("完成审批");
    expect(auditEventLabel("workflow_failed", "zh")).toBe("工作流失败");
    expect(auditEventLabel("mcp_binding_changed", "zh")).toBe("变更 MCP 连接");
    expect(auditEventLabel("compute_policy_changed", "zh")).toBe("变更 Compute 策略");
    expect(auditEventLabel("future_event", "zh")).toBe("future_event");
    expect(auditEventLabel("workflow_failed", "en")).toBe("workflow failed");
  });

  it("exposes initial loading semantics and rejects stale audit responses", () => {
    expect(source).toContain("requestSequenceRef.current !== requestId");
    expect(source).toContain("settledFilterKey !== filterKey");
    expect(source).toContain("activeFilterKeyRef.current !== requestedFilterKey");
    expect(source).toContain("正在读取工作区审计事件");
    expect(source).toContain("aria-busy={initialLoading || loading || loadingMore}");
  });
});
