import { pathToFileURL } from "node:url";

import {
  getAllWorkspaceWalletReconciliationReports,
  getWorkspaceWalletReconciliationReport,
  prisma,
  WorkspaceWalletReconciliationInputError,
  type AllWorkspaceWalletReconciliationInput,
  type WorkspaceWalletReconciliationInput,
  type WorkspaceWalletReconciliationReport,
  type WorkspaceWalletReconciliationStatus,
} from "../packages/web-data/src/index";

export type WalletReconcileCliOptions = {
  mode: "all" | "workspace";
  workspace: string | null;
  representative: string;
  currency: string | null;
  format: "json" | "pretty";
};

export type WalletReconcileCliReport = {
  schemaVersion: 1;
  readOnly: true;
  mode: "all" | "workspace";
  scope: {
    workspace: string | null;
    representative: string;
    currency: string | null;
  };
  status: WorkspaceWalletReconciliationStatus;
  summary: {
    workspaces: number;
    healthy: number;
    warnings: number;
    blocked: number;
  };
  reports: WorkspaceWalletReconciliationReport[];
};

export type WalletReconcileCliDependencies = {
  getWorkspaceWalletReconciliationReport: (
    input: WorkspaceWalletReconciliationInput,
  ) => Promise<WorkspaceWalletReconciliationReport | null>;
  getAllWorkspaceWalletReconciliationReports: (
    input?: AllWorkspaceWalletReconciliationInput,
  ) => Promise<WorkspaceWalletReconciliationReport[]>;
  prisma: {
    representative: {
      findUnique: (input: {
        where: { slug: string };
        select: { ownerId: true };
      }) => Promise<{ ownerId: string } | null>;
    };
    disconnect: () => Promise<void>;
  };
};

export type WalletReconcileCliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

export type WalletReconcileCliRunOptions = {
  dependencies?: WalletReconcileCliDependencies;
  io?: WalletReconcileCliIo;
};

export class WalletReconcileCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletReconcileCliUsageError";
  }
}

const defaultDependencies: WalletReconcileCliDependencies = {
  getWorkspaceWalletReconciliationReport,
  getAllWorkspaceWalletReconciliationReports,
  prisma: {
    representative: {
      findUnique: (input) => prisma.representative.findUnique(input),
    },
    disconnect: () => prisma.$disconnect(),
  },
};

const defaultIo: WalletReconcileCliIo = {
  stdout: (value) => {
    process.stdout.write(`${value}\n`);
  },
  stderr: (value) => {
    process.stderr.write(`${value}\n`);
  },
};

export function parseWalletReconcileArgs(
  argv: readonly string[],
): WalletReconcileCliOptions {
  let all = false;
  let workspace: string | null = null;
  let representative = "all";
  let currency: string | null = null;
  let format: WalletReconcileCliOptions["format"] = "json";
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--all") {
      assertUniqueArgument(seen, token);
      all = true;
      continue;
    }

    if (
      token === "--workspace"
      || token === "--representative"
      || token === "--currency"
      || token === "--format"
    ) {
      assertUniqueArgument(seen, token);
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new WalletReconcileCliUsageError(
          `${token} requires a value.`,
        );
      }
      index += 1;

      if (token === "--workspace") {
        workspace = value;
      } else if (token === "--representative") {
        representative = value;
      } else if (token === "--currency") {
        currency = value.toUpperCase();
      } else {
        if (value !== "json" && value !== "pretty") {
          throw new WalletReconcileCliUsageError(
            "--format must be json or pretty.",
          );
        }
        format = value;
      }
      continue;
    }

    throw new WalletReconcileCliUsageError("Unknown argument.");
  }

  if (all === Boolean(workspace)) {
    throw new WalletReconcileCliUsageError(
      "Specify exactly one of --all or --workspace <slug>.",
    );
  }
  if (all && representative !== "all") {
    throw new WalletReconcileCliUsageError(
      "--representative <slug> requires --workspace.",
    );
  }

  return {
    mode: all ? "all" : "workspace",
    workspace,
    representative,
    currency,
    format,
  };
}

export async function runWalletReconcileCli(
  argv: readonly string[],
  runOptions: WalletReconcileCliRunOptions = {},
): Promise<number> {
  const dependencies = runOptions.dependencies ?? defaultDependencies;
  const io = runOptions.io ?? defaultIo;
  let exitCode = 3;
  let renderedReport: string | null = null;
  let cleanupFailed = false;

  try {
    const options = parseWalletReconcileArgs(argv);
    const reports = options.mode === "all"
      ? await dependencies.getAllWorkspaceWalletReconciliationReports({
          ...(options.currency ? { currency: options.currency } : {}),
        })
      : await loadWorkspaceReport(options, dependencies);
    const report = buildWalletReconcileCliReport(options, reports);

    renderedReport = options.format === "json"
      ? JSON.stringify(report)
      : formatWalletReconcileCliReport(report);
    exitCode = report.status === "healthy" ? 0 : 1;
  } catch (error) {
    if (
      error instanceof WalletReconcileCliUsageError
      || error instanceof WorkspaceWalletReconciliationInputError
    ) {
      io.stderr(error.message);
      exitCode = 2;
    } else {
      io.stderr("Wallet reconciliation execution failed.");
      exitCode = 3;
    }
  } finally {
    try {
      await dependencies.prisma.disconnect();
    } catch {
      io.stderr("Wallet reconciliation cleanup failed.");
      cleanupFailed = true;
      exitCode = 3;
    }
  }

  if (renderedReport && !cleanupFailed) {
    io.stdout(renderedReport);
  }
  return exitCode;
}

export function buildWalletReconcileCliReport(
  options: WalletReconcileCliOptions,
  reports: WorkspaceWalletReconciliationReport[],
): WalletReconcileCliReport {
  const summary = {
    workspaces: reports.length,
    healthy: reports.filter((report) => report.status === "healthy").length,
    warnings: reports.filter((report) => report.status === "warning").length,
    blocked: reports.filter((report) => report.status === "blocked").length,
  };
  const status: WorkspaceWalletReconciliationStatus = summary.blocked > 0
    ? "blocked"
    : summary.warnings > 0
      ? "warning"
      : "healthy";

  return {
    schemaVersion: 1,
    readOnly: true,
    mode: options.mode,
    scope: {
      workspace: options.workspace,
      representative: options.representative,
      currency: options.currency,
    },
    status,
    summary,
    reports,
  };
}

export function formatWalletReconcileCliReport(
  report: WalletReconcileCliReport,
): string {
  const lines = [
    `Wallet reconciliation: ${report.status.toUpperCase()}`,
    report.mode === "all"
      ? "Scope: all workspaces"
      : `Scope: workspace ${report.scope.workspace}`,
    `Reports: ${report.summary.workspaces}`
      + ` (${report.summary.healthy} healthy,`
      + ` ${report.summary.warnings} warning,`
      + ` ${report.summary.blocked} blocked)`,
  ];

  for (const workspaceReport of report.reports) {
    lines.push(
      `- ${workspaceReport.scope.ownerId}`
      + ` / ${workspaceReport.scope.representative}`
      + ` / ${workspaceReport.scope.currency}:`
      + ` ${workspaceReport.status}`
      + ` (${workspaceReport.summary.findings} findings)`,
    );
    for (const issue of workspaceReport.issues) {
      lines.push(
        `  [${issue.severity.toUpperCase()}] ${issue.code}`
        + ` expected=${formatNullableValue(issue.expectedValue)}`
        + ` actual=${formatNullableValue(issue.actualValue)}`
        + ` difference=${formatNullableValue(issue.differenceValue)}`,
      );
    }
    if (workspaceReport.issuesTruncated) {
      lines.push(
        `  ... ${workspaceReport.issueCount - workspaceReport.issues.length}`
        + " additional findings omitted",
      );
    }
  }

  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  process.exitCode = await runWalletReconcileCli(argv);
}

async function loadWorkspaceReport(
  options: WalletReconcileCliOptions,
  dependencies: WalletReconcileCliDependencies,
): Promise<WorkspaceWalletReconciliationReport[]> {
  const activeRepresentativeSlug = options.workspace!;
  const representative = await dependencies.prisma.representative.findUnique({
    where: { slug: activeRepresentativeSlug },
    select: { ownerId: true },
  });
  if (!representative) {
    throw new WalletReconcileCliUsageError(
      "Workspace representative was not found.",
    );
  }

  const report = await dependencies.getWorkspaceWalletReconciliationReport({
    ownerId: representative.ownerId,
    activeRepresentativeSlug,
    representative: options.representative,
    ...(options.currency ? { currency: options.currency } : {}),
  });
  if (!report) {
    throw new WalletReconcileCliUsageError(
      "Workspace wallet scope was not found.",
    );
  }
  return [report];
}

function assertUniqueArgument(seen: Set<string>, argument: string) {
  if (seen.has(argument)) {
    throw new WalletReconcileCliUsageError(
      `${argument} may only be specified once.`,
    );
  }
  seen.add(argument);
}

function formatNullableValue(value: number | null) {
  return value === null ? "n/a" : String(value);
}

const entryPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPath && import.meta.url === entryPath) {
  main().catch(() => {
    process.stderr.write("Wallet reconciliation execution failed.\n");
    process.exitCode = 3;
  });
}
