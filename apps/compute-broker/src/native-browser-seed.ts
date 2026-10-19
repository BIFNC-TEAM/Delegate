import { createHash } from "node:crypto";
import { AgentContextAuthorizationError } from "@delegate/runtime";
import { assertAgentContextForExecution, isAgentContextArtifactAuthorized } from "@delegate/web-data";
import { prisma } from "./prisma";
import { readPersistedArtifactObject } from "./artifacts";
import { SessionError } from "./session-error";

const deny = (): never => { throw new AgentContextAuthorizationError(); };

/** A screenshot is input data, not an authorization token. Until cross-run
 * dependency inheritance exists, audience tasks may reuse only their own run. */
export async function loadLatestNativeBrowserSeed(input: {
  computeSessionId: string;
  sandboxIdentityId?: string | null | undefined;
}) {
  const loadMetadata = async () => {
    const target = await prisma.computeSession.findUnique({ where: { id: input.computeSessionId }, select: {
      id: true, representativeId: true, contactId: true, conversationId: true, generationRunId: true, requestedBy: true,
      conversation: { select: { audienceIdentityId: true } },
    } });
    if (!target) return deny();
    if (target.requestedBy !== "OWNER") {
      if (target.requestedBy !== "AUDIENCE" || !target.generationRunId || !target.conversation?.audienceIdentityId) return deny();
      await assertAgentContextForExecution(target.generationRunId);
    }
    const browser = await prisma.browserSession.findFirst({
      where: {
        ...(input.sandboxIdentityId ? { sandboxIdentityId: input.sandboxIdentityId } : { computeSessionId: target.id }),
        representativeId: target.representativeId, contactId: target.contactId, conversationId: target.conversationId,
        ...(target.requestedBy === "AUDIENCE" ? { computeSession: { generationRunId: target.generationRunId } } : {}),
      }, orderBy: [{ updatedAt: "desc" }],
      select: { id: true, profilePath: true, computeSessionId: true, navigations: { orderBy: [{ createdAt: "desc" }], take: 1,
        select: { id: true, updatedAt: true, toolExecutionId: true, screenshotArtifactId: true, status: true,
          representativeId: true, contactId: true, conversationId: true } } },
    });
    const navigation = browser?.navigations[0];
    if (!browser || !navigation?.screenshotArtifactId) throw new SessionError(409, "native_browser_seed_missing");
    // A stateless public capture cannot bootstrap the retained-profile native
    // action loop. Doing so could import unrelated cookies on the next action.
    if (browser.profilePath === "__delegate_anonymous_v1__") throw new SessionError(409, "native_browser_stateless_seed_unsupported");
    if (navigation.status !== "SUCCEEDED" || navigation.representativeId !== target.representativeId
      || navigation.contactId !== target.contactId || navigation.conversationId !== target.conversationId) return deny();
    const artifact = await prisma.artifact.findUnique({ where: { id: navigation.screenshotArtifactId }, select: {
      id: true, representativeId: true, contactId: true, conversationId: true, sessionId: true, toolExecutionId: true,
      objectKey: true, mimeType: true, kind: true, sha256: true, sizeBytes: true, retentionUntil: true,
      session: { select: { generationRunId: true, requestedBy: true } },
      toolExecution: { select: { sessionId: true, status: true } },
    } });
    if (!artifact || artifact.kind !== "SCREENSHOT" || !["image/png", "image/jpeg"].includes(artifact.mimeType)
      || artifact.sizeBytes <= 0 || artifact.sizeBytes > 20 * 1024 * 1024
      || (artifact.retentionUntil && artifact.retentionUntil <= new Date())
      || artifact.representativeId !== target.representativeId || artifact.contactId !== target.contactId
      || artifact.conversationId !== target.conversationId || artifact.sessionId !== browser.computeSessionId
      || artifact.toolExecutionId !== navigation.toolExecutionId || artifact.toolExecution?.sessionId !== artifact.sessionId
      || artifact.toolExecution.status !== "SUCCEEDED") return deny();
    if (target.requestedBy === "AUDIENCE") {
      if (artifact.session?.requestedBy !== "AUDIENCE" || artifact.session.generationRunId !== target.generationRunId
        || !target.conversationId || !await isAgentContextArtifactAuthorized({ runId: target.generationRunId!,
          representativeId: target.representativeId, conversationId: target.conversationId,
          audienceIdentityId: target.conversation!.audienceIdentityId! })) return deny();
    }
    // An owner session cannot silently promote audience-derived media into
    // the legacy owner path, which has no visitor source manifest.
    if (target.requestedBy === "OWNER" && artifact.session?.requestedBy !== "OWNER") return deny();
    return { target, browserId: browser.id, navigation, artifact };
  };
  const original = await loadMetadata();
  const stamp = JSON.stringify(original);
  const revalidate = async () => { if (JSON.stringify(await loadMetadata()) !== stamp) return deny(); };
  // No page title, snippet, URL or object bytes are read before source checks.
  const page = await prisma.browserNavigation.findFirst({ where: { id: original.navigation.id, updatedAt: original.navigation.updatedAt },
    select: { finalUrl: true, pageTitle: true, textSnippet: true } });
  if (!page) return deny();
  const bytes = await readPersistedArtifactObject(original.artifact.objectKey);
  if (bytes.byteLength !== original.artifact.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== original.artifact.sha256) return deny();
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (original.artifact.mimeType === "image/png" ? !png : !jpeg) return deny();
  await revalidate();
  return { currentUrl: page.finalUrl, currentTitle: page.pageTitle, textSnippet: page.textSnippet,
    screenshotBase64: bytes.toString("base64"), screenshotMimeType: original.artifact.mimeType as "image/png" | "image/jpeg", revalidate };
}
