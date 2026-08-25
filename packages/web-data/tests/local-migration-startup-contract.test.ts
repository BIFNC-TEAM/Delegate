import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};
const migrationsRoot = new URL("../../../prisma/migrations/", import.meta.url);

describe("local database migration startup contract", () => {
  it("separates first-time image builds from daily Turbopack startup", () => {
    expect(rootPackage.scripts?.["docker:build:local"]).toBe(
      "bash scripts/docker-compose-local.sh build migrate openviking",
    );
    expect(rootPackage.scripts?.["docker:bootstrap:local"]).toBe(
      "bash scripts/docker-compose-local.sh build migrate openviking && bash scripts/docker-compose-local.sh up -d openviking site dashboard reps bot compute-broker workflow-runner conversation-worker",
    );
    expect(rootPackage.scripts?.["docker:migrate:local"]).toBe(
      "bash scripts/docker-compose-local.sh run --rm migrate",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).toBe(
      "pnpm docker:migrate:local && bash scripts/docker-compose-local.sh up -d openviking site dashboard reps bot compute-broker workflow-runner conversation-worker",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).toContain(
      "pnpm docker:migrate:local &&",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      " build ",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      "--force-recreate",
    );
  });

  it("rejects migration directories without a migration.sql file", () => {
    const invalidDirectories = readdirSync(migrationsRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !existsSync(
        new URL(`${entry.name}/migration.sql`, migrationsRoot),
      ))
      .map((entry) => entry.name)
      .sort();

    expect(invalidDirectories).toEqual([]);
  });
});
