import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const compose = readFileSync(
  resolve(repoRoot, "compose.logto.yml"),
  "utf8",
);
const composeServices = compose.slice(compose.indexOf("\nservices:\n") + 1);
const environmentExample = readFileSync(
  resolve(repoRoot, "deploy/logto/logto.env.example"),
  "utf8",
);
const runbook = readFileSync(
  resolve(repoRoot, "docs/logto-self-hosting-runbook.md"),
  "utf8",
);
const verifyWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/verify.yml"),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

const scripts = [
  "deploy/logto/env.sh",
  "deploy/logto/bootstrap.sh",
  "deploy/logto/compose.sh",
  "deploy/logto/preflight.sh",
  "deploy/logto/init.sh",
  "deploy/logto/up.sh",
  "deploy/logto/backup.sh",
  "deploy/logto/verify-backup.sh",
  "deploy/logto/alter.sh",
  "deploy/logto/smoke.sh",
];

function serviceBlock(name: string) {
  const start = composeServices.indexOf(`  ${name}:`);
  expect(start, `service ${name} must exist`).toBeGreaterThan(-1);
  const remaining = composeServices.slice(start + 2);
  const next = remaining.search(/^  [a-z0-9-]+:\s*$/m);
  return next === -1
    ? composeServices.slice(start)
    : composeServices.slice(start, start + 2 + next);
}

describe("self-hosted Logto local Compose contract", () => {
  it("pins the official v1.41.0 image and never permits latest", () => {
    expect(compose).toContain(
      "svhd/logto:1.41.0",
    );
    expect(environmentExample).toContain(
      "LOGTO_OSS_IMAGE=svhd/logto:1.41.0",
    );
    expect(compose).not.toMatch(/logto:(?:latest|\$\{[^}]*latest)/u);
    expect(environmentExample).not.toContain("logto:latest");
  });

  it("keeps Logto data in its own unexposed PostgreSQL service and volume", () => {
    const postgres = serviceBlock("logto-postgres");

    expect(postgres).toContain("postgres:17-alpine");
    expect(postgres).toContain(
      "logto-postgres-data:/var/lib/postgresql/data",
    );
    expect(postgres).toContain("pg_isready");
    expect(postgres).not.toContain("ports:");
    expect(compose).toContain("name: delegate-logto-postgres-v1");
  });

  it("keeps seeding and alteration as explicit non-restarting jobs", () => {
    const seed = serviceBlock("logto-seed");
    const alteration = serviceBlock("logto-alteration");
    const application = serviceBlock("logto");

    expect(seed).toContain('profiles: ["seed"]');
    expect(seed).toContain("npm run cli db seed -- --swe");
    expect(seed).toContain("--disable-admin-pwned-password-check");
    expect(alteration).toContain('profiles: ["alteration"]');
    expect(alteration).toContain('CI: "true"');
    expect(alteration).toContain("npm run alteration deploy latest");
    expect(application).not.toContain("logto-seed");
    expect(application).not.toContain("logto-alteration");
  });

  it("separates core and Admin Console ports on loopback and probes discovery", () => {
    const application = serviceBlock("logto");

    expect(application).toContain(
      '"127.0.0.1:${LOGTO_OSS_CORE_PORT:-3301}:3001"',
    );
    expect(application).toContain(
      '"127.0.0.1:${LOGTO_OSS_ADMIN_PORT:-3302}:3002"',
    );
    expect(application).toContain(
      "/oidc/.well-known/openid-configuration",
    );
    expect(environmentExample).toContain(
      "LOGTO_OSS_ENDPOINT=http://127.0.0.1:3301",
    );
    expect(environmentExample).toContain(
      "LOGTO_OSS_ADMIN_ENDPOINT=http://127.0.0.1:3302",
    );
  });

  it("keeps operational scripts syntactically valid and local-only", () => {
    for (const script of scripts) {
      execFileSync("bash", ["-n", resolve(repoRoot, script)]);
    }

    const envSource = readFileSync(
      resolve(repoRoot, "deploy/logto/env.sh"),
      "utf8",
    );
    const composeWrapper = readFileSync(
      resolve(repoRoot, "deploy/logto/compose.sh"),
      "utf8",
    );
    const alteration = readFileSync(
      resolve(repoRoot, "deploy/logto/alter.sh"),
      "utf8",
    );
    const backup = readFileSync(
      resolve(repoRoot, "deploy/logto/backup.sh"),
      "utf8",
    );
    const smoke = readFileSync(
      resolve(repoRoot, "deploy/logto/smoke.sh"),
      "utf8",
    );

    expect(envSource).toContain("logto_validate_loopback_endpoint");
    expect(envSource).toContain(
      '[[ "$value" == "svhd/logto:1.41.0" ]]',
    );
    expect(composeWrapper).toContain("config --environment");
    expect(composeWrapper).toContain("--env-file /dev/null");
    expect(composeWrapper).toContain('COMPOSE_COMMAND_ARGS+=(--no-interpolate)');
    expect(alteration).toContain("--backup");
    expect(alteration).toContain("verify-backup.sh");
    expect(alteration).toContain("--require-current-env");
    expect(alteration).toContain("logto_acquire_local_operation_lock");
    expect(backup).toContain("logto_acquire_local_operation_lock");
    expect(backup).toContain("logto.dump");
    expect(backup).toContain("logto.env");
    expect(backup).toContain("dump_sha256");
    expect(smoke).toContain("/oidc/token");
    expect(smoke).toContain('<div id="app"></div>');
  });

  it("exposes one documented package command per lifecycle action", () => {
    expect(rootPackage.scripts?.["logto:local:bootstrap"]).toBe(
      "bash deploy/logto/bootstrap.sh",
    );
    expect(rootPackage.scripts?.["logto:local:config"]).toBe(
      "bash deploy/logto/compose.sh config",
    );
    expect(rootPackage.scripts?.["logto:local:init"]).toBe(
      "bash deploy/logto/init.sh",
    );
    expect(rootPackage.scripts?.["logto:local:up"]).toBe(
      "bash deploy/logto/up.sh",
    );
    expect(rootPackage.scripts?.["logto:local:backup"]).toBe(
      "bash deploy/logto/backup.sh",
    );
    expect(rootPackage.scripts?.["logto:local:verify-backup"]).toBe(
      "bash deploy/logto/verify-backup.sh",
    );
    expect(rootPackage.scripts?.["logto:local:smoke"]).toBe(
      "bash deploy/logto/smoke.sh",
    );
    expect(rootPackage.scripts?.["logto:local:down"]).toBe(
      "bash deploy/logto/compose.sh down",
    );
    expect(rootPackage.scripts?.["test:logto:config"]).toBe(
      "vitest run scripts/tests/logto-compose-contract.test.ts",
    );
    expect(verifyWorkflow).toContain(
      "pnpm test:logto:config && pnpm logto:local:config > /dev/null",
    );
  });

  it("states the production boundaries and single-run upgrade rule", () => {
    expect(runbook).toContain("must not be used as the production manifest");
    expect(runbook).toContain("image digest");
    expect(runbook).toMatch(/single-run\s+alteration/u);
    expect(runbook).toContain("Admin Console");
    expect(runbook).toContain("RPO");
    expect(runbook).toContain("RTO");
    expect(runbook).toContain("Secret Vault KEK");
    expect(runbook).toContain("packages/core/connectors");
    expect(runbook).toContain("singleton");
  });

  it("documents isolated application clients, fixed callbacks, and split endpoints", () => {
    expect(runbook).toContain("LOGTO_DASHBOARD_APP_ID");
    expect(runbook).toContain("LOGTO_REPS_APP_ID");
    expect(runbook).toContain("http://localhost:3002/auth/callback");
    expect(runbook).toContain("LOGTO_BACKCHANNEL_ENDPOINT");
    expect(runbook).toMatch(
      /Authorization and issuer validation always use\s+`LOGTO_ENDPOINT`/u,
    );
    expect(runbook).toContain("DELEGATE_REPS_LEGACY_CALLBACK_UNTIL");
    expect(runbook).toContain("returns `410` before any token call");
  });
});
