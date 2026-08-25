import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const executionsSource = readFileSync(
  new URL("../src/executions.ts", import.meta.url),
  "utf8",
);

describe("execution filesystem policy", () => {
  it("never replaces the effective policy with an audience/browser override", () => {
    expect(executionsSource).not.toContain('filesystemMode: "ephemeral_full"');
    expect(executionsSource).not.toContain("resolveExecutionIsolationContext");
    expect(
      executionsSource.match(/resolveExecutionFilesystemMode\(/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
  });
});
