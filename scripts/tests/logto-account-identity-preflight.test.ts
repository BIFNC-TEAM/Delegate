import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const sql = readFileSync(
  resolve(repoRoot, "prisma/preflight/logto-account-identity-conflicts.sql"),
  "utf8",
);
const runner = readFileSync(
  resolve(repoRoot, "scripts/logto-account-identity-preflight.sh"),
  "utf8",
);
const runnerPath = resolve(
  repoRoot,
  "scripts/logto-account-identity-preflight.sh",
);
const matrixE2eFixture = readFileSync(
  resolve(repoRoot, "scripts/tests/matrix-synapse-delegate.e2e.ts"),
  "utf8",
);

describe("Logto Account identity preflight", () => {
  it("runs the identity report in a read-only transaction", () => {
    expect(sql).toContain("BEGIN TRANSACTION READ ONLY");
    expect(sql).toContain("COMMIT;");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("reports issuer, principal, persona, and workspace ambiguities", () => {
    expect(sql).toContain("OWNER_LOGTO_ISSUER_REQUIRED");
    expect(sql).toContain("OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED");
    expect(sql).toContain("OWNER_LOGTO_ISSUER_EVIDENCE_MISMATCH");
    expect(sql).toContain("AUDIENCE_LOGTO_ISSUER_REQUIRED");
    expect(sql).toContain("PRINCIPAL_MULTIPLE_OWNER_IDENTITIES");
    expect(sql).toContain("PRINCIPAL_MULTIPLE_AUDIENCE_IDENTITIES");
    expect(sql).toContain("CROSS_PERSONA_ACCOUNT_MAPPING_REQUIRED");
    expect(sql).toContain("SAME_EMAIL_DIFFERENT_PRINCIPAL_REVIEW");
    expect(sql).toContain("OWNER_ORGANIZATION_MEMBERSHIP_MISMATCH");
    expect(sql).toContain("MULTI_OWNER_ORGANIZATION_MAPPING_REQUIRED");
    expect(sql).toContain('FROM "OrganizationMember" AS member');
  });

  it("keeps the Matrix E2E fake Logto identity on one valid HTTP issuer", () => {
    const issuer = matrixE2eFixture.match(
      /const matrixLocalE2eLogtoIssuer\s*=\s*"([^"]+)";/u,
    )?.[1];
    expect(issuer).toBe(
      "https://matrix-local-e2e.delegate.invalid/oidc",
    );
    expect(new URL(issuer!).protocol).toBe("https:");

    const identityFixture = matrixE2eFixture.slice(
      matrixE2eFixture.indexOf(
        "async function ensureRegisteredWebTestIdentity",
      ),
      matrixE2eFixture.indexOf("\nvoid main().catch"),
    );
    expect(identityFixture).toContain('provider: "LOGTO"');
    expect(
      identityFixture.match(
        /issuer:\s*matrixLocalE2eLogtoIssuer/gu,
      ),
    ).toHaveLength(2);
    expect(identityFixture).not.toMatch(
      /issuer:\s*["'][^"']+["']/u,
    );
  });

  it("fails blockers and makes review rows strict only on request", () => {
    expect(runner).toContain('--strict)');
    expect(runner).toContain('--approvals)');
    expect(runner).toContain('--write-approval-template)');
    expect(runner).toContain("grep -q '^BLOCKER,'");
    expect(runner).toContain("blocking identity conflicts were found.");
    expect(runner).toContain("strict mode requires --approvals FILE");
  });

  it("can use the repository PostgreSQL container when psql is not installed", () => {
    expect(runner).toContain("docker compose exec -T postgres");
    expect(runner).toContain("--file /dev/stdin");
  });

  it("executes the runner and enforces blocker/review exit codes", () => {
    const fixtureRoot = mkdtempSync(
      resolve(tmpdir(), "delegate-logto-preflight-test-"),
    );
    const fakePsql = resolve(fixtureRoot, "psql");
    writeFileSync(
      fakePsql,
      [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "printf '%s\\n' \"${FAKE_PSQL_REPORT-}\"",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakePsql, 0o700);

    const run = (report: string, args: string[] = []) =>
      spawnSync("bash", [runnerPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://preflight.invalid/delegate",
          FAKE_PSQL_REPORT: report,
          PSQL_BIN: fakePsql,
        },
      });
    const header = "severity,issue_code,entity_type,entity_key,details";
    const reviewReport =
      `${header}\nREVIEW,CROSS_PERSONA_ACCOUNT_MAPPING_REQUIRED,logto_principal,principal-1,` +
      `"{""ownerId"": ""owner-1"", ""audienceIdentityId"": ""audience-1""}"`;

    try {
      expect(run(header).status).toBe(0);
      expect(
        run(
          `${header}\nBLOCKER,OWNER_LOGTO_ISSUER_REQUIRED,owner_identity_link,link-1,{}`,
        ).status,
      ).toBe(2);
      expect(
        run(reviewReport).status,
      ).toBe(0);
      expect(run(reviewReport, ["--strict"]).status).toBe(3);

      const templatePath = resolve(fixtureRoot, "approvals.json");
      expect(
        run(reviewReport, ["--write-approval-template", templatePath]).status,
      ).toBe(0);
      expect(statSync(templatePath).mode & 0o777).toBe(0o600);

      const artifact = JSON.parse(readFileSync(templatePath, "utf8"));
      artifact.approvals[0] = {
        ...artifact.approvals[0],
        decision: "map both personas to one Account",
        approvedBy: "security-reviewer@example.com",
        approvedAt: "2026-07-29T08:00:00.000Z",
      };
      writeFileSync(templatePath, `${JSON.stringify(artifact)}\n`, "utf8");
      expect(
        run(reviewReport, [
          "--strict",
          "--approvals",
          templatePath,
        ]).status,
      ).toBe(0);

      artifact.approvals[0].detailsSha256 = createHash("sha256")
        .update('{"changed":true}', "utf8")
        .digest("hex");
      writeFileSync(templatePath, `${JSON.stringify(artifact)}\n`, "utf8");
      expect(
        run(reviewReport, [
          "--strict",
          "--approvals",
          templatePath,
        ]).status,
      ).toBe(3);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
