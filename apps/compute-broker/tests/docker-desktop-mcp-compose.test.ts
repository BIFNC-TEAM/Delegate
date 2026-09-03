import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(__dirname, "../../..");
const compose = readFileSync(resolve(projectRoot, "compose.yml"), "utf8");
const exampleEnv = readFileSync(resolve(projectRoot, ".env.example"), "utf8");

describe("Docker Desktop MCP DNS proxy configuration", () => {
  it("passes the local-only opt-in through Compose with a safe default", () => {
    expect(compose).toContain(
      "DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY: ${DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY:-false}",
    );
    expect(exampleEnv).toContain(
      'DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY="false"',
    );
    expect(exampleEnv).toContain("keep false in production");
  });
});
