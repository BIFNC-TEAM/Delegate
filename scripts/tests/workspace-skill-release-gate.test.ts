import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gateScript = join(repoRoot, "scripts/workspace-skill-release-gate.sh");
const preflightSql = join(
  repoRoot,
  "prisma/preflight/workspace-skill-legacy-version-conflicts.sql",
);
const workspaceInstallMigration = join(
  repoRoot,
  "prisma/migrations/20260723113000_workspace_skill_governance/migration.sql",
);
const workspaceReleaseMigration = join(
  repoRoot,
  "prisma/migrations/20260723143000_workspace_skill_release_governance/migration.sql",
);
const legacyReconciliationMigration = join(
  repoRoot,
  "prisma/migrations/20260723220000_reconcile_legacy_multi_representative_skill_versions/migration.sql",
);
const legacyCorrectiveMigration = join(
  repoRoot,
  "prisma/migrations/20260723224000_workspace_skill_legacy_ambiguity_corrective/migration.sql",
);
const checksumHelper = join(
  repoRoot,
  "scripts/workspace-skill-migration-checksums.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "delegate-migration-gate-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function targetFingerprint(input: {
  protocol?: string;
  hostname: string;
  port?: string;
  database?: string;
}) {
  const targetIdentity = [
    input.protocol ?? "postgresql",
    input.hostname.toLowerCase(),
    input.port ?? "5432",
    input.database ?? "delegate",
  ].join("|");

  return createHash("sha256").update(targetIdentity).digest("hex").slice(0, 16);
}

function writeBackupProof(
  directory: string,
  environment: string,
  hostname: string,
  database = "delegate",
  timestamps: {
    createdAt?: string;
    restoreVerifiedAt?: string;
  } = {},
) {
  const proofPath = join(directory, "backup-proof.json");
  const now = new Date().toISOString();

  writeFileSync(
    proofPath,
    JSON.stringify({
      environment,
      databaseTargetFingerprint: targetFingerprint({ hostname, database }),
      snapshotId: "snapshot-test-001",
      createdAt: timestamps.createdAt ?? now,
      restoreVerifiedAt: timestamps.restoreVerifiedAt ?? now,
    }),
  );

  return proofPath;
}

function installFakeTools(
  directory: string,
  options: {
    conflict?: boolean;
    migrationChecksumRows?: string[];
    migrationStatusExitCode?: number;
    migrationStatusOutput?: string;
  } = {},
) {
  const fakeBin = join(directory, "bin");
  const commandLog = join(directory, "commands.log");
  const header =
    "ownerId,skillPackId,source,slug,issueCodes,bindingCount,representativeCount,missingVersionBindingCount,distinctVersionCount,versions,distinctStatusCount,installStatuses,installedStatusBindingCount,updateAvailableStatusBindingCount,selectedVersion,selectedBindingId,selectedRepresentativeId,selectedRepresentativeSlug,selectedBindingStatus,selectedBindingUpdatedAt,affectedReleaseCount,affectedPendingApprovalCount";
  const conflictRow =
    'owner_gate,skill_gate,BUILTIN,gate-skill,"{version_conflict,status_conflict}",2,2,0,2,"{1.0.0,2.0.0}",2,"{installed,update_available}",1,1,2.0.0,binding_new,rep_new,gate-new,update_available,2026-02-01 00:00:00,2,0';
  const migrationChecksumOutput = (options.migrationChecksumRows ?? [])
    .map((row) => `printf '%s\\n' '${row}'`)
    .join("\n");

  execFileSync("mkdir", ["-p", fakeBin]);
  writeFileSync(
    join(fakeBin, "psql"),
    `#!/bin/sh
printf 'psql:PGOPTIONS=%s\\n' "$PGOPTIONS" >> "$GATE_COMMAND_LOG"
case "$*" in
  *"_prisma_migrations"*)
    ${migrationChecksumOutput || ":"}
    ;;
  *)
    printf '%s\\n' '${header}'
    ${options.conflict ? `printf '%s\\n' '${conflictRow}'` : ""}
    ;;
esac
`,
  );
  writeFileSync(
    join(fakeBin, "pnpm"),
    `#!/bin/sh
printf 'pnpm:%s\\n' "$*" >> "$GATE_COMMAND_LOG"
case "$*" in
  *"migrate status"*)
    printf '%s\\n' '${options.migrationStatusOutput ?? ""}' >&2
    exit ${options.migrationStatusExitCode ?? 0}
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  chmodSync(join(fakeBin, "psql"), 0o755);
  chmodSync(join(fakeBin, "pnpm"), 0o755);

  return { fakeBin, commandLog };
}

function runGate(
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync("bash", [gateScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
    },
  });
}

describe("workspace-skill release gate", () => {
  it("is syntactically valid and keeps deployment behind localhost-only guards", () => {
    execFileSync("bash", ["-n", gateScript], { cwd: repoRoot });

    const source = readFileSync(gateScript, "utf8");
    const remoteGuard = source.indexOf(
      'if [[ "$MODE" == "deploy" && "$DATABASE_HOST_CLASS" != "local" ]]',
    );
    const deployCommand = source.indexOf('pnpm --dir "$REPO_ROOT" db:deploy');

    expect(source).toContain('MODE="preflight"');
    expect(source).toContain('--maintenance-confirmed');
    expect(source).toContain('--conflicts-reviewed');
    expect(source).toContain('--allow-local-deploy');
    expect(remoteGuard).toBeGreaterThan(-1);
    expect(deployCommand).toBeGreaterThan(remoteGuard);
  });

  it("requires an explicit target environment and backup proof", () => {
    const result = runGate([], {
      DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--environment must be provided explicitly");
  });

  it("rejects automatic deployment for every remote database before invoking tools", () => {
    const directory = createTemporaryDirectory();
    const hostname = "db.staging.example";
    const proofPath = writeBackupProof(directory, "staging", hostname);
    const commandLog = join(directory, "commands.log");

    const result = runGate(
      [
        "--environment",
        "staging",
        "--backup-proof",
        proofPath,
        "--mode",
        "deploy",
        "--maintenance-confirmed",
        "--conflicts-reviewed",
        "--allow-local-deploy",
      ],
      {
        DATABASE_URL: `postgresql://user:secret@${hostname}:5432/delegate`,
        GATE_COMMAND_LOG: commandLog,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "automatic deployment is restricted to explicit localhost",
    );
    expect(() => readFileSync(commandLog, "utf8")).toThrow();
  });

  it("runs only read-only checksum, preflight, and status checks in default mode", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");
    const { fakeBin, commandLog } = installFakeTools(directory);

    const result = runGate(
      ["--environment", "local", "--backup-proof", proofPath],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode=preflight");
    expect(result.stdout).toContain("backup_proof=valid");
    expect(result.stdout).toContain("migration_checksum_status=match");
    expect(result.stdout).toContain("conflict_groups=0");
    expect(result.stdout).toContain("deployment=not_requested");

    const commands = readFileSync(commandLog, "utf8");
    expect(commands).toContain("exec prisma migrate status");
    expect(commands).not.toContain("db:deploy");
    expect(commands).toContain("lock_timeout=5000ms");
    expect(commands).toContain("statement_timeout=300000ms");
  });

  it("blocks an applied migration checksum mismatch and names the migration", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");
    const migrationName =
      "20260723113000_workspace_skill_governance";
    const { fakeBin, commandLog } = installFakeTools(directory, {
      migrationChecksumRows: [`${migrationName}|${"0".repeat(64)}`],
    });

    const result = runGate(
      [
        "--environment",
        "local",
        "--backup-proof",
        proofPath,
        "--mode",
        "deploy",
        "--maintenance-confirmed",
        "--allow-local-deploy",
      ],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("migration_checksum_status=mismatch");
    expect(result.stdout).toContain(
      `migration_checksum_mismatch=${migrationName}`,
    );
    expect(result.stderr).toContain("There is no automatic override");
    expect(readFileSync(commandLog, "utf8")).not.toContain("db:deploy");
  });

  it("accepts applied checksums and ignores local migrations not returned by the database", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");
    const migrationName =
      "20260723113000_workspace_skill_governance";
    const checksum = createHash("sha256")
      .update(readFileSync(workspaceInstallMigration))
      .digest("hex");
    const { fakeBin, commandLog } = installFakeTools(directory, {
      migrationChecksumRows: [`${migrationName}|${checksum}`],
    });

    const result = runGate(
      ["--environment", "local", "--backup-proof", proofPath],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("migration_checksum_status=match");
    expect(result.stdout).not.toContain(
      "20260723224000_workspace_skill_legacy_ambiguity_corrective",
    );
  });

  it("binds backup proof to protocol, host, port, and database", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");
    const mismatchedTargets = [
      "postgres://user:secret@localhost:5432/delegate",
      "postgresql://user:secret@localhost:5544/delegate",
      "postgresql://user:secret@localhost:5432/delegate_production",
    ];

    for (const databaseUrl of mismatchedTargets) {
      const result = runGate(
        ["--environment", "local", "--backup-proof", proofPath],
        { DATABASE_URL: databaseUrl },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "databaseTargetFingerprint does not match DATABASE_URL",
      );
    }
  });

  it("rejects a restore verification that predates the backup artifact", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(
      directory,
      "local",
      "localhost",
      "delegate",
      {
        createdAt: new Date().toISOString(),
        restoreVerifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    );

    const result = runGate(
      ["--environment", "local", "--backup-proof", proofPath],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "restoreVerifiedAt cannot predate createdAt",
    );
  });

  it("requires maintenance and explicit local deployment flags", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");

    const result = runGate(
      [
        "--environment",
        "local",
        "--backup-proof",
        proofPath,
        "--mode",
        "deploy",
      ],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--maintenance-confirmed");
  });

  it("requires conflict review only when the preflight reports conflict rows", () => {
    const directory = createTemporaryDirectory();
    const proofPath = writeBackupProof(directory, "local", "localhost");
    const { fakeBin, commandLog } = installFakeTools(directory, { conflict: true });

    const result = runGate(
      [
        "--environment",
        "local",
        "--backup-proof",
        proofPath,
        "--mode",
        "deploy",
        "--maintenance-confirmed",
        "--allow-local-deploy",
      ],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: commandLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--conflicts-reviewed");
    expect(readFileSync(commandLog, "utf8")).not.toContain("db:deploy");

    const cleanDirectory = createTemporaryDirectory();
    const cleanProof = writeBackupProof(cleanDirectory, "local", "localhost");
    const cleanTools = installFakeTools(cleanDirectory);
    const cleanResult = runGate(
      [
        "--environment",
        "local",
        "--backup-proof",
        cleanProof,
        "--mode",
        "deploy",
        "--maintenance-confirmed",
        "--allow-local-deploy",
      ],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: cleanTools.commandLog,
        PATH: `${cleanTools.fakeBin}:${process.env.PATH}`,
      },
    );

    expect(cleanResult.status).toBe(0);
    expect(readFileSync(cleanTools.commandLog, "utf8")).toContain("db:deploy");
  });

  it("allows pending migrations before deployment but blocks failed migrations", () => {
    const pendingDirectory = createTemporaryDirectory();
    const pendingProof = writeBackupProof(pendingDirectory, "local", "localhost");
    const pendingTools = installFakeTools(pendingDirectory, {
      migrationStatusExitCode: 1,
      migrationStatusOutput: "Following migration have not yet been applied",
    });
    const pendingResult = runGate(
      ["--environment", "local", "--backup-proof", pendingProof],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: pendingTools.commandLog,
        PATH: `${pendingTools.fakeBin}:${process.env.PATH}`,
      },
    );

    expect(pendingResult.status).toBe(0);
    expect(pendingResult.stdout).toContain("migration_status=pending");

    const failedDirectory = createTemporaryDirectory();
    const failedProof = writeBackupProof(failedDirectory, "local", "localhost");
    const failedTools = installFakeTools(failedDirectory, {
      migrationStatusExitCode: 1,
      migrationStatusOutput: "P3009: migrate found failed migrations",
    });
    const failedResult = runGate(
      ["--environment", "local", "--backup-proof", failedProof],
      {
        DATABASE_URL: "postgresql://user:secret@localhost:5432/delegate",
        GATE_COMMAND_LOG: failedTools.commandLog,
        PATH: `${failedTools.fakeBin}:${process.env.PATH}`,
      },
    );

    expect(failedResult.status).not.toBe(0);
    expect(failedResult.stdout).toContain("migration_status=failed");
    expect(failedResult.stderr).toContain("Prisma reports a failed migration");
  });

  it("keeps the preflight read-only and reports migration impact counts", () => {
    const source = readFileSync(preflightSql, "utf8");

    expect(source).toContain("BEGIN TRANSACTION READ ONLY");
    expect(source).toContain('"issueCodes"');
    expect(source).toContain('"bindingCount"');
    expect(source).toContain('"representativeCount"');
    expect(source).toContain('"missingVersionBindingCount"');
    expect(source).toContain('"distinctStatusCount"');
    expect(source).toContain('"installedStatusBindingCount"');
    expect(source).toContain('"updateAvailableStatusBindingCount"');
    expect(source).toContain('"affectedReleaseCount"');
    expect(source).toContain('"affectedPendingApprovalCount"');
    expect(source).toContain("ROLLBACK");
  });

  it("never infers an installed version or release from catalog metadata", () => {
    const installMigration = readFileSync(workspaceInstallMigration, "utf8");
    const releaseMigration = readFileSync(workspaceReleaseMigration, "utf8");
    const reconciliationMigration = readFileSync(
      legacyReconciliationMigration,
      "utf8",
    );

    expect(installMigration).toContain(
      'NULLIF(BTRIM(binding."installedVersion"), \'\') AS "installedVersion"',
    );
    expect(installMigration).toContain(
      '(legacy."installedVersion" IS NOT NULL) DESC',
    );
    expect(releaseMigration).not.toContain(
      'COALESCE(install."installedVersion", pack."version"',
    );
    expect(releaseMigration).toContain(
      'WHERE NULLIF(BTRIM(install."installedVersion"), \'\') IS NOT NULL',
    );
    expect(reconciliationMigration).toContain(
      "Only a non-empty historical binding can establish an installed version",
    );
    expect(reconciliationMigration).toContain('"enabled" = false');
    expect(reconciliationMigration).toContain(
      "ELSE 'NEEDS_REVIEW'::\"WorkspaceSkillReviewStatus\"",
    );
    expect(reconciliationMigration).toContain("THEN 'available'");
    const correctiveMigration = readFileSync(
      legacyCorrectiveMigration,
      "utf8",
    );
    expect(correctiveMigration).toContain(
      "legacy multi-representative version reconciliation",
    );
    expect(correctiveMigration).toContain(
      "Catalog metadata is not adoption evidence",
    );
    expect(correctiveMigration).toContain(
      "'system:migration:20260723224000'",
    );
    expect(correctiveMigration).toContain('"enabled" = false');
  });

  it("validates applied migration checksums with the local migration bytes", () => {
    const migrationName =
      "20260723113000_workspace_skill_governance";
    const checksum = createHash("sha256")
      .update(readFileSync(workspaceInstallMigration))
      .digest("hex");

    const match = spawnSync(
      "node",
      [checksumHelper, join(repoRoot, "prisma/migrations")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        input: `${migrationName}|${checksum}\n`,
      },
    );
    expect(match.status).toBe(0);
    expect(match.stdout).toBe("");

    const mismatch = spawnSync(
      "node",
      [checksumHelper, join(repoRoot, "prisma/migrations")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        input: `${migrationName}|${"f".repeat(64)}\n`,
      },
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain(
      `${migrationName}|checksum_mismatch`,
    );
  });

  it("documents Docker fallback, restore rehearsal, timeouts, and PostgreSQL tests", () => {
    for (const filename of ["README.md", "README.zh-CN.md"]) {
      const source = readFileSync(join(repoRoot, filename), "utf8");

      expect(source).toContain("docker compose exec -T postgres psql");
      expect(source).toContain("pg_dump");
      expect(source).toContain("pg_restore");
      expect(source).toContain("PGOPTIONS");
      expect(source).toContain("pnpm test:postgres:skills");
      expect(source).toContain("pnpm test:migration-fixture:pg16");
      expect(source).toContain("missing_version");
      expect(source).toContain("status_conflict");
    }
  });
});
