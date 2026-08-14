import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};

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
      "bash scripts/docker-compose-local.sh up -d openviking site dashboard reps bot compute-broker workflow-runner conversation-worker",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      " build ",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      "--force-recreate",
    );
  });
});
