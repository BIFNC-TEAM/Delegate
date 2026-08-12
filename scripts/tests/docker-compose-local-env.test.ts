import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(__dirname, "../..");
const packageJson = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const composeWrapper = readFileSync(
  resolve(projectRoot, "scripts/docker-compose-local.sh"),
  "utf8",
);

describe("local Compose environment loading", () => {
  it("loads the base environment before the optional local WeChat override", () => {
    expect(composeWrapper).toContain("compose_env_args=(--env-file .env)");
    expect(composeWrapper).toContain("[[ -f .env.wechat.local ]]");
    expect(composeWrapper).toContain(
      "compose_env_args+=(--env-file .env.wechat.local)",
    );
    expect(composeWrapper.indexOf("--env-file .env.wechat.local")).toBeGreaterThan(
      composeWrapper.indexOf("--env-file .env"),
    );
  });

  it("routes every local Compose lifecycle command through the wrapper", () => {
    for (const scriptName of [
      "docker:build:local",
      "docker:bootstrap:local",
      "docker:migrate:local",
      "docker:up:local",
    ]) {
      expect(packageJson.scripts?.[scriptName]).toContain(
        "bash scripts/docker-compose-local.sh",
      );
    }
  });
});
