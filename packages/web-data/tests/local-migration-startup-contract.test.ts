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
      "docker compose -f compose.yml -f compose.local.yml build migrate openviking",
    );
    expect(rootPackage.scripts?.["docker:bootstrap:local"]).toBe(
      "docker compose -f compose.yml -f compose.local.yml build migrate openviking && docker compose -f compose.yml -f compose.local.yml up -d openviking site dashboard reps bot compute-broker workflow-runner conversation-worker",
    );
    expect(rootPackage.scripts?.["docker:migrate:local"]).toBe(
      "docker compose -f compose.yml -f compose.local.yml run --rm migrate",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).toBe(
      "docker compose -f compose.yml -f compose.local.yml up -d openviking site dashboard reps bot compute-broker workflow-runner conversation-worker",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      " build ",
    );
    expect(rootPackage.scripts?.["docker:up:local"]).not.toContain(
      "--force-recreate",
    );
  });
});
