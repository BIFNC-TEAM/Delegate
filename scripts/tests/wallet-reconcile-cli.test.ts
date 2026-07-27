import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseWalletReconcileArgs,
  runWalletReconcileCli,
  WalletReconcileCliUsageError,
  type WalletReconcileCliDependencies,
  type WalletReconcileCliIo,
} from "../wallet-reconcile";
import {
  WorkspaceWalletReconciliationInputError,
  type WorkspaceWalletReconciliationReport,
} from "../../packages/web-data/src/index";

function createReport(
  status: WorkspaceWalletReconciliationReport["status"] = "healthy",
): WorkspaceWalletReconciliationReport {
  const warnings = status === "warning" ? 1 : 0;
  const errors = status === "blocked" ? 1 : 0;
  return {
    schemaVersion: 1,
    checkedAt: "2026-07-27T01:00:00.000Z",
    readOnly: true,
    status,
    scope: {
      ownerId: "owner-1",
      representative: "all",
      currency: "CNY",
    },
    summary: {
      checks: 4,
      passed: 4 - warnings - errors,
      warnings,
      errors,
      findings: warnings + errors,
      absoluteAmountDifferenceCents: errors ? 100 : 0,
      absoluteTokenDifference: 0,
    },
    issues: [],
    issueCount: warnings + errors,
    issuesTruncated: false,
  };
}

function createHarness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies = {
    getWorkspaceWalletReconciliationReport: vi.fn()
      .mockResolvedValue(createReport()),
    getAllWorkspaceWalletReconciliationReports: vi.fn()
      .mockResolvedValue([createReport()]),
    prisma: {
      representative: {
        findUnique: vi.fn().mockResolvedValue({ ownerId: "owner-1" }),
      },
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  } as WalletReconcileCliDependencies;
  const io: WalletReconcileCliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { dependencies, io, stdout, stderr };
}

describe("wallet reconciliation CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses explicit all and workspace modes with stable defaults", () => {
    expect(parseWalletReconcileArgs(["--all"])).toEqual({
      mode: "all",
      workspace: null,
      representative: "all",
      currency: null,
      format: "json",
    });
    expect(parseWalletReconcileArgs([
      "--workspace",
      "delegate",
      "--representative",
      "support",
      "--currency",
      "usd",
      "--format",
      "json",
    ])).toEqual({
      mode: "workspace",
      workspace: "delegate",
      representative: "support",
      currency: "USD",
      format: "json",
    });
  });

  it("rejects ambiguous, incomplete, duplicate, and unsupported arguments", () => {
    expect(() => parseWalletReconcileArgs([]))
      .toThrow(WalletReconcileCliUsageError);
    expect(() => parseWalletReconcileArgs([
      "--all",
      "--workspace",
      "delegate",
    ])).toThrow("Specify exactly one");
    expect(() => parseWalletReconcileArgs(["--workspace"]))
      .toThrow("--workspace requires a value.");
    expect(() => parseWalletReconcileArgs(["--all", "--all"]))
      .toThrow("--all may only be specified once.");
    expect(() => parseWalletReconcileArgs(["--all", "--format", "xml"]))
      .toThrow("--format must be json or pretty.");
    expect(() => parseWalletReconcileArgs(["--all", "--repair"]))
      .toThrow("Unknown argument.");
    expect(() => parseWalletReconcileArgs([
      "--all",
      "--representative",
      "delegate",
    ])).toThrow("--representative <slug> requires --workspace.");
  });

  it("resolves workspace ownership and emits one JSON report", async () => {
    const harness = createHarness();

    const exitCode = await runWalletReconcileCli([
      "--workspace",
      "delegate",
      "--representative",
      "support",
      "--currency",
      "cny",
    ], harness);

    expect(exitCode).toBe(0);
    expect(harness.dependencies.prisma.representative.findUnique)
      .toHaveBeenCalledWith({
        where: { slug: "delegate" },
        select: { ownerId: true },
      });
    expect(harness.dependencies.getWorkspaceWalletReconciliationReport)
      .toHaveBeenCalledWith({
        ownerId: "owner-1",
        activeRepresentativeSlug: "delegate",
        representative: "support",
        currency: "CNY",
      });
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({
      schemaVersion: 1,
      readOnly: true,
      mode: "workspace",
      status: "healthy",
      summary: {
        workspaces: 1,
        healthy: 1,
        warnings: 0,
        blocked: 0,
      },
    });
    expect(harness.stderr).toEqual([]);
    expect(harness.dependencies.prisma.disconnect).toHaveBeenCalledOnce();
  });

  it("runs all workspaces and returns one when any report needs attention", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.getAllWorkspaceWalletReconciliationReports)
      .mockResolvedValue([
        createReport("healthy"),
        createReport("blocked"),
      ]);

    const exitCode = await runWalletReconcileCli([
      "--all",
      "--currency",
      "usd",
      "--format",
      "pretty",
    ], harness);

    expect(exitCode).toBe(1);
    expect(harness.dependencies.getAllWorkspaceWalletReconciliationReports)
      .toHaveBeenCalledWith({ currency: "USD" });
    expect(harness.dependencies.getWorkspaceWalletReconciliationReport)
      .not.toHaveBeenCalled();
    expect(harness.stdout).toHaveLength(1);
    expect(harness.stdout[0]).toContain("Wallet reconciliation: BLOCKED");
    expect(harness.stdout[0]).toContain("Reports: 2");
    expect(harness.stderr).toEqual([]);
    expect(harness.dependencies.prisma.disconnect).toHaveBeenCalledOnce();
  });

  it("returns two for a missing workspace without invoking reconciliation", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.prisma.representative.findUnique)
      .mockResolvedValue(null);

    const exitCode = await runWalletReconcileCli([
      "--workspace",
      "missing",
    ], harness);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "Workspace representative was not found.",
    ]);
    expect(harness.dependencies.getWorkspaceWalletReconciliationReport)
      .not.toHaveBeenCalled();
    expect(harness.dependencies.prisma.disconnect).toHaveBeenCalledOnce();
  });

  it("returns two for a reconciliation range error", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.getWorkspaceWalletReconciliationReport)
      .mockRejectedValue(
        new WorkspaceWalletReconciliationInputError(
          "Selected currency is not available in this workspace.",
        ),
      );

    const exitCode = await runWalletReconcileCli([
      "--workspace",
      "delegate",
      "--currency",
      "USD",
    ], harness);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "Selected currency is not available in this workspace.",
    ]);
    expect(harness.dependencies.prisma.disconnect).toHaveBeenCalledOnce();
  });

  it("redacts unexpected execution errors and always disconnects", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.getAllWorkspaceWalletReconciliationReports)
      .mockRejectedValue(
        new Error("postgres://owner:password@private-host/delegate"),
      );

    const exitCode = await runWalletReconcileCli(["--all"], harness);

    expect(exitCode).toBe(3);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "Wallet reconciliation execution failed.",
    ]);
    expect(harness.stderr.join(" ")).not.toContain("password");
    expect(harness.stderr.join(" ")).not.toContain("private-host");
    expect(harness.dependencies.prisma.disconnect).toHaveBeenCalledOnce();
  });

  it("turns cleanup failures into a redacted execution failure", async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.prisma.disconnect).mockRejectedValue(
      new Error("postgres://owner:password@private-host/delegate"),
    );

    const exitCode = await runWalletReconcileCli([
      "--workspace",
      "delegate",
      "--format",
      "json",
    ], harness);

    expect(exitCode).toBe(3);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "Wallet reconciliation cleanup failed.",
    ]);
    expect(harness.stderr.join(" ")).not.toContain("password");
    expect(harness.stderr.join(" ")).not.toContain("private-host");
  });
});
