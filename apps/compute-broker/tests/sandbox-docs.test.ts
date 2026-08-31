import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const doc = readFileSync(
  resolve(__dirname, "../../../docs/per-user-sandbox-runtime.md"),
  "utf8",
);

describe("per-user sandbox runtime docs", () => {
  it("documents rollout, cost controls, observability, and rollback", () => {
    expect(doc).toContain("per-user sandbox identity + on-demand runtime");
    expect(doc).toContain("This is not \"one always-on VM per audience user.\"");
    expect(doc).toContain("SANDBOX_PROVIDER=daytona");
    expect(doc).toContain("Manual PoC mode fails closed");
    expect(doc).toContain("TENCENT_AGS_CODE_TOOL=delegate-code-v1");
    expect(doc).toContain("SANDBOX_IDLE_STOP_MINUTES");
    expect(doc).toContain("/internal/compute/sandbox/metrics");
    expect(doc).toContain("curl http://localhost:4010/ready");
    expect(doc).toContain("SANDBOX_PROVIDER=docker");
  });
});
