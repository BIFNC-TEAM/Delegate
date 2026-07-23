import { describe, expect, it } from "vitest";

import {
  buildWorkspaceAuditSafeMetadata,
  classifyWorkspaceAuditEvent,
  countWorkspaceAuditEventsWithinLast24Hours,
  decodeWorkspaceAuditCursor,
  encodeWorkspaceAuditCursor,
  getWorkspaceAuditSnapshot,
  summarizeWorkspaceAuditTypeCounts,
  WorkspaceAuditInputError,
} from "../src/workspace-audit";

describe("workspace audit normalization", () => {
  it("returns an honest empty snapshot in database-free demo mode", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const snapshot = await getWorkspaceAuditSnapshot({
        activeRepresentativeSlug: "lin-founder-rep",
      });
      expect(snapshot?.metrics.total).toBe(0);
      expect(snapshot?.events).toEqual([]);
      expect(snapshot?.page).toEqual({
        filteredTotal: 0,
        limit: 50,
        hasMore: false,
        nextCursor: null,
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("classifies events into stable workspace categories", () => {
    expect(classifyWorkspaceAuditEvent("skill_version_adopted")).toBe("skills");
    expect(classifyWorkspaceAuditEvent("approval_resolved")).toBe("approvals");
    expect(classifyWorkspaceAuditEvent("workflow_failed")).toBe("workflow");
    expect(classifyWorkspaceAuditEvent("representative_version_published")).toBe("publishing");
    expect(classifyWorkspaceAuditEvent("tool_execution_failed")).toBe("tools");
  });

  it("derives workspace-wide totals from grouped counts without a row-window cap", () => {
    expect(summarizeWorkspaceAuditTypeCounts([
      { type: "skill_version_adopted", count: 701 },
      { type: "approval_resolved", count: 302 },
      { type: "workflow_failed", count: 97 },
      { type: "message_answered", count: 500 },
    ])).toEqual({
      total: 1600,
      decisions: 1003,
      categories: [
        { id: "skills", count: 701 },
        { id: "publishing", count: 0 },
        { id: "approvals", count: 302 },
        { id: "wallet", count: 0 },
        { id: "tools", count: 0 },
        { id: "workflow", count: 97 },
        { id: "conversation", count: 500 },
        { id: "security", count: 0 },
        { id: "other", count: 0 },
      ],
    });
  });

  it("round-trips the stable createdAt/id keyset cursor and rejects malformed input", () => {
    const cursor = encodeWorkspaceAuditCursor({
      createdAt: "2026-07-23T16:00:00.000Z",
      id: "event_same_timestamp_b",
    });
    expect(decodeWorkspaceAuditCursor(cursor)).toEqual({
      createdAt: new Date("2026-07-23T16:00:00.000Z"),
      id: "event_same_timestamp_b",
    });
    expect(() => decodeWorkspaceAuditCursor("not-json")).toThrow(WorkspaceAuditInputError);
    expect(() => decodeWorkspaceAuditCursor(Buffer.from(JSON.stringify({
      v: 1,
      createdAt: "2026-07-23",
      id: "event",
    })).toString("base64url"))).toThrow(WorkspaceAuditInputError);
  });

  it("exports allowlisted metadata without commands, credentials, or raw payload fields", () => {
    expect(buildWorkspaceAuditSafeMetadata({
      status: "FAILED",
      version: "1.2.3",
      requestedCommand: "cat /private/secret",
      token: "secret",
      nested: { credential: "secret" },
    })).toEqual({ status: "FAILED", version: "1.2.3" });
  });

  it("counts a rolling 24-hour window without server calendar-day semantics", () => {
    const now = new Date("2026-07-23T16:00:00.000Z");
    expect(countWorkspaceAuditEventsWithinLast24Hours([
      { createdAt: "2026-07-23T15:59:59.999Z" },
      { createdAt: "2026-07-22T16:00:00.000Z" },
      { createdAt: "2026-07-22T15:59:59.999Z" },
      { createdAt: "2026-07-23T16:00:00.001Z" },
      { createdAt: "not-a-date" },
    ], now)).toBe(2);
  });
});
