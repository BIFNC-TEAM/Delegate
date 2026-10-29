import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ session: vi.fn(), browser: vi.fn(), navigation: vi.fn(), artifact: vi.fn(), read: vi.fn(), authorize: vi.fn(), source: vi.fn() }));
vi.mock("../src/prisma", () => ({ prisma: { computeSession: { findUnique: db.session }, browserSession: { findFirst: db.browser },
  browserNavigation: { findFirst: db.navigation }, artifact: { findUnique: db.artifact } } }));
vi.mock("../src/artifacts", () => ({ readPersistedArtifactObject: db.read }));
vi.mock("@delegate/web-data", () => ({ assertAgentContextForExecution: db.authorize, isAgentContextArtifactAuthorized: db.source }));
import { loadLatestNativeBrowserSeed } from "../src/native-browser-seed";
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64");
const scope = { representativeId: "rep", contactId: "contact", conversationId: "conversation" };
let artifact: Record<string, any>;
describe("retained browser seed source authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.session.mockResolvedValue({ ...scope, id: "session", generationRunId: "run", requestedBy: "AUDIENCE", conversation: { audienceIdentityId: "visitor" } });
    db.browser.mockResolvedValue({ id: "browser", computeSessionId: "session", navigations: [{ ...scope, id: "nav", updatedAt: new Date(1), toolExecutionId: "execution", screenshotArtifactId: "image", status: "SUCCEEDED" }] });
    artifact = { ...scope, id: "image", sessionId: "session", toolExecutionId: "execution", objectKey: "synthetic", kind: "SCREENSHOT", mimeType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, retentionUntil: null,
      session: { generationRunId: "run", requestedBy: "AUDIENCE" }, toolExecution: { sessionId: "session", status: "SUCCEEDED" } };
    db.artifact.mockImplementation(async () => structuredClone(artifact));
    db.navigation.mockResolvedValue({ finalUrl: "https://example.invalid", pageTitle: "Synthetic", textSnippet: "SYNTHETIC_MEDIA_CANARY" });
    db.read.mockResolvedValue(bytes); db.authorize.mockResolvedValue(undefined); db.source.mockResolvedValue(true);
  });
  it("permits the same authorized run and queries scope metadata before page data", async () => {
    const result = await loadLatestNativeBrowserSeed({ computeSessionId: "session", sandboxIdentityId: "sandbox" });
    expect(result.screenshotBase64).toBe(bytes.toString("base64")); expect(result.textSnippet).toBe("SYNTHETIC_MEDIA_CANARY");
    expect(db.browser).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ...scope, computeSession: { generationRunId: "run" } }) }));
    expect(db.source.mock.invocationCallOrder[0]).toBeLessThan(db.navigation.mock.invocationCallOrder[0]!);
    expect(db.read).toHaveBeenCalledOnce(); await result.revalidate(); expect(db.read).toHaveBeenCalledOnce();
  });
  it.each(["origin_run", "visitor_scope", "execution", "session", "expired", "source_revoked"])("does not read page data or object bytes for %s", async change => {
    if (change === "origin_run") artifact.session.generationRunId = "old-run";
    if (change === "visitor_scope") artifact.conversationId = "other-conversation";
    if (change === "execution") artifact.toolExecutionId = "other-execution";
    if (change === "session") artifact.toolExecution.sessionId = "other-session";
    if (change === "expired") artifact.retentionUntil = new Date(1);
    if (change === "source_revoked") db.source.mockResolvedValue(false);
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: "session" })).rejects.toThrow("authorization_failed");
    expect(db.navigation).not.toHaveBeenCalled(); expect(db.read).not.toHaveBeenCalled();
  });
  it("withholds a blob corrupted in storage", async () => {
    db.read.mockResolvedValue(Buffer.from("SYNTHETIC_CORRUPT_IMAGE"));
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: "session" })).rejects.toThrow("authorization_failed");
  });
  it("does not promote audience media through an owner session", async () => {
    db.session.mockResolvedValue({ ...scope, id: "session", generationRunId: null, requestedBy: "OWNER", conversation: { audienceIdentityId: "visitor" } });
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: "session" })).rejects.toThrow("authorization_failed");
    expect(db.navigation).not.toHaveBeenCalled(); expect(db.read).not.toHaveBeenCalled();
  });
  it("does not seed retained native actions from a stateless public capture", async () => {
    db.browser.mockResolvedValue({ id: "browser", profilePath: "__delegate_anonymous_v1__", computeSessionId: "session",
      navigations: [{ ...scope, id: "nav", updatedAt: new Date(1), toolExecutionId: "execution", screenshotArtifactId: "image", status: "SUCCEEDED" }] });
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: "session" })).rejects.toThrow("native_browser_stateless_seed_unsupported");
    expect(db.navigation).not.toHaveBeenCalled(); expect(db.read).not.toHaveBeenCalled();
  });
  it("checks again when access is revoked during storage read and on later model boundaries", async () => {
    db.read.mockImplementationOnce(async () => { db.source.mockResolvedValue(false); return bytes; });
    await expect(loadLatestNativeBrowserSeed({ computeSessionId: "session" })).rejects.toThrow("authorization_failed");
    db.source.mockResolvedValue(true);
    const result = await loadLatestNativeBrowserSeed({ computeSessionId: "session" });
    db.source.mockResolvedValue(false);
    await expect(result.revalidate()).rejects.toThrow("authorization_failed");
  });
});
