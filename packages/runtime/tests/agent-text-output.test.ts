import { describe, expect, it } from "vitest";
import { validateAgentTextOutputRequest, validateAgentTextOutputContent } from "../src/agent-text-output";

function validate(name: string, content: string) {
  const request = validateAgentTextOutputRequest([name]);
  if (!request.ok || !request.file) throw new Error("invalid fixture");
  return validateAgentTextOutputContent(request.file, content);
}

describe("current Agent text output contract", () => {
  it.each(["report.csv", "outputs/report.csv", "/workspace/outputs/report.csv"])("normalizes an allowed output path %s", path => {
    expect(validateAgentTextOutputRequest([path])).toEqual({ ok: true, file: { fileName: "report.csv", format: "csv", mimeType: "text/csv" } });
  });
  it.each(["../report.csv", "outputs/../report.csv", "C:\\report.csv", "report.pdf", "report.xlsx", "report.html", "report.txt/ignored"])("rejects unsupported path or format %s", path => {
    expect(validateAgentTextOutputRequest([path]).ok).toBe(false);
  });
  it.each([
    "名称,值\n甲,1\n",
    'name,value\r\n"A,B",1\r\n',
    'name,value\n"A\nB",1\n',
    'name,value\n"A""B",1\n',
    "name\nA\n",
  ])("accepts complete rectangular CSV with quoting and Unicode: %j", text => {
    expect(validate("report.csv", text)).toEqual({ ok: true });
  });
  it.each(["name,value\nA,1,2\n", 'name,value\n"unfinished,1', 'name,value\n"A"extra,1\n', "name,name\nA,1\n", ",value\nA,1\n"])("rejects malformed CSV: %j", text => {
    expect(validate("report.csv", text)).toEqual({ ok: false, reason: "output_csv_invalid" });
  });
  it("checks JSON, controls and UTF-8 byte limits without changing content", () => {
    expect(validate("report.json", '{"a":1}\n').ok).toBe(true);
    expect(validate("report.json", '{"a":').ok).toBe(false);
    expect(validate("report.txt", "a\u0000b").ok).toBe(false);
    expect(validate("report.txt", "a".repeat(65_536)).ok).toBe(true);
    expect(validate("report.txt", "文".repeat(22_000))).toEqual({ ok: false, reason: "output_file_too_large" });
    expect(validateAgentTextOutputRequest(["a.txt", "b.txt"]).ok).toBe(false);
  });
});
