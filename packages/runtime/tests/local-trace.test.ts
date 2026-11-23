import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localTraceEvent, sanitizeLocalTrace, withLocalTrace } from "../src/local-trace";
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "local-trace-")); dirs.push(dir); return dir; }
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("explicit local complete tracing", () => {
  it("does not create files when disabled", async () => {
    const dir = directory(); vi.stubEnv("DELEGATE_LOCAL_TRACE_DIR", dir); vi.stubEnv("DELEGATE_LOCAL_TRACE_ENABLED", "0");
    expect(await withLocalTrace("test", {}, async () => { localTraceEvent("secret", "not written"); return 3; })).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("keeps long bodies and native error causes while omitting secrets and hidden thinking", () => {
    const cause = Object.assign(new Error("db_deadlock"), { code: "P2034" });
    const result = sanitizeLocalTrace({ body: "正文".repeat(100000), apiKey: "secret", token: "private", databaseUrl: "postgresql://user:private@localhost:5432/test", error: new Error("boundary", { cause }),
      contents: [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text: "VISIBLE" }],
      raw: '{"password":"private","answer":"unchanged"}', url: "https://user:password@example.com/doc?token=private",
      text: "Bearer abc123456 secret-value" }, ["secret-value"]) as any;
    expect(result.body).toHaveLength(200000); expect(result.error.cause.code).toBe("P2034");
    const json = JSON.stringify(result); expect(json).not.toContain("HIDDEN"); expect(json).not.toContain("private"); expect(json).not.toContain("abc123456"); expect(json).not.toContain("secret-value");
    expect(result.contents).toEqual([{ type: "text", text: "VISIBLE" }]); expect(JSON.parse(result.raw).password).toBe("[REDACTED]");
  });
  it("keeps per-request order, parallel isolation, terminal failures and restricted permissions", async () => {
    const dir = directory(); vi.stubEnv("DELEGATE_LOCAL_TRACE_DIR", dir); vi.stubEnv("DELEGATE_LOCAL_TRACE_ENABLED", "1");
    await Promise.allSettled(["a", "b"].map(runId => withLocalTrace("worker", { runId }, async () => {
      localTraceEvent("model.input", { runId, full: "input" }); await Promise.resolve(); localTraceEvent("tool.result", { runId, full: "output" });
      if (runId === "b") throw Object.assign(new Error("failed"), { code: "test_failure" }); return { runId };
    })));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir); expect(files).toHaveLength(2);
    for (const file of files) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      const rows = readFileSync(join(dir, file), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4]);
      expect(new Set(rows.map(row => row.coordinates.runId)).size).toBe(1);
      expect(rows[1].data.runId).toBe(rows[0].coordinates.runId);
      expect(rows.at(-1).event).toBe(rows[0].coordinates.runId === "a" ? "lifecycle.completed" : "lifecycle.failed");
    }
  });
});
