import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ findUnique: vi.fn(), load: vi.fn() }));
vi.mock("../src/prisma", () => ({ prisma: { generationRun: { findUnique: f.findUnique } } }));
vi.mock("@delegate/web-data", () => ({ buildSandboxAttachmentFileName: (id: string) => `attachment-${id}.csv`, loadGenerationInputAttachments: f.load }));
import { loadVerifiedPythonInputs, pythonActionId, validatePythonRequest, verifyPythonInputManifest } from "../src/isolated-python/request";
const content = Buffer.from("a,b\n1,2\n");
const checksum = createHash("sha256").update(content).digest("hex");
const request = { profileId: "delegate.aio.single-python.v1" as const, actionKey: "call-1", source: "print(1)", timeoutMs: 1000,
  inputs: [{ attachmentId: "a", fileName: "attachment-a.csv", sizeBytes: content.length, checksum }] };
beforeEach(() => {
  vi.clearAllMocks();
  f.findUnique.mockResolvedValue({ inputMessage: { attachments: [{ id: "a", fileName: "x.csv", sizeBytes: content.length, checksum, objectKey: "synthetic-only" }] } });
  f.load.mockResolvedValue([{ id: "a", sandboxFileName: "attachment-a.csv", sizeBytes: content.length, checksum, base64: content.toString("base64") }]);
});
describe("bound Python inputs", () => {
  it("checks metadata without reading the private body for approval", async () => { await verifyPythonInputManifest("run", request); expect(f.load).not.toHaveBeenCalled(); });
  it.each(["id", "fileName", "sizeBytes", "checksum"])("rejects a changed %s before body read", async field => {
    const changed = { ...request, inputs: [{ ...request.inputs[0]!, ...({ id: { attachmentId: "other" }, fileName: { fileName: "secret.txt" }, sizeBytes: { sizeBytes: 2 }, checksum: { checksum: "0".repeat(64) } }[field]) }] };
    await expect(loadVerifiedPythonInputs("run", changed)).rejects.toThrow("changed_or_unavailable"); expect(f.load).not.toHaveBeenCalled();
  });
  it("rejects bytes changed after metadata validation", async () => { f.load.mockResolvedValue([{ id: "a", sandboxFileName: "attachment-a.csv", sizeBytes: content.length, checksum: "0".repeat(64), base64: content.toString("base64") }]); await expect(loadVerifiedPythonInputs("run", request)).rejects.toThrow("changed_or_unavailable"); });
  it("does not interpret no requested input as all attachments", async () => { expect(await loadVerifiedPythonInputs("run", { ...request, inputs: [] })).toEqual([]); expect(f.load).not.toHaveBeenCalled(); expect(f.findUnique).not.toHaveBeenCalled(); });
  it("loads exactly the authorized immutable input bytes", async () => { expect(await loadVerifiedPythonInputs("run", request)).toEqual([{ fileName: "attachment-a.csv", content }]); expect(f.load).toHaveBeenCalledWith({ generationRunId: "run", attachmentIds: ["a"] }); });
  it("bounds UTF-8 bytes, rejects duplicate input identities and unsupported outputs", () => {
    expect(() => validatePythonRequest({ ...request, source: "汉".repeat(30000) })).toThrow();
    expect(() => validatePythonRequest({ ...request, inputs: [...request.inputs, ...request.inputs] })).toThrow();
    expect(() => validatePythonRequest({ ...request, outputFileName: "fake.pdf" })).toThrow();
  });
  it("distinguishes a new call or a new user turn from message replay", () => {
    expect(pythonActionId("run", "call")).toBe(pythonActionId("run", "call"));
    expect(pythonActionId("run", "call2")).not.toBe(pythonActionId("run", "call"));
    expect(pythonActionId("run2", "call")).not.toBe(pythonActionId("run", "call"));
  });
});
