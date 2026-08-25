import { createHash } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { demoRepresentative } from "@delegate/domain";
import { generateRepresentativeReply } from "@delegate/model-runtime";
import { createConversationPlan, renderReplyPreview, resolveConversationSubagent } from "@delegate/runtime";
import {
  acceptInboundConversationMessage,
  AgentWalletReconciliationError,
  buildRepresentativeRuntimeProfile,
  buildWebAudienceExternalUserId,
  ConversationIngressValidationError,
  getUserAgentWalletBalance,
  getPublicConversationHistory,
  getPublicRepresentativeRuntime,
  resolvePublicAudienceWalletExternalUserId,
  enforcePublicChatNetworkAdmission,
  enforcePublicChatPrincipalAdmission,
  deleteArtifactObject,
  PublicChatRateLimitError,
  resolveWebAudienceContact,
  resolveWebAudienceConversation,
  ServiceCreditRequiredError,
  validateInboundConversationPayload,
  writeArtifactObject,
  type PublicAudiencePrincipal,
} from "@delegate/web-data";

import {
  deriveTierUsage,
  normalizePublicChatRequest,
  publicMemoryDisclosureMatches,
  resolvePublicChatTier,
} from "../public-chat";
import {
  assertPublicAudienceResourceOwner,
  publicAudiencePrincipalErrorStatus,
  resolvePublicAudienceRequestPrincipal,
  setPublicAudienceSessionCookie,
} from "../public-principal";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const runtime = await getPublicRepresentativeRuntime(slug);
  if (runtime.status !== "available") return publicRuntimeError(runtime.status);

  try {
    const audienceRequest = await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });
    const { principal, sessionState } = audienceRequest;
    let history = { state: "new", humanActive: false, freeRepliesUsed: 0, messages: [] as Array<unknown> };
    try {
      history = await getPublicConversationHistory({
        representativeSlug: slug,
        audienceIdentityId: principal.audienceIdentityId,
        audienceId: principal.audienceId,
      });
    } catch (error) {
      if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
    }
    const externalUserId = await resolvePublicWalletExternalUserId({
      principal,
      representativeSlug: slug,
    });

    const response = NextResponse.json({
      ...history,
      usage: await derivePublicWalletUsage({
        representativeId: runtime.setup.id,
        externalUserId,
        freeRepliesUsed: history.freeRepliesUsed,
        freeReplyLimit: runtime.setup.contract.freeReplyLimit,
        accessMode: runtime.accessMode,
      }),
    });
    response.headers.set("Cache-Control", "private, no-store");
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    const principalError = publicPrincipalErrorResponse(error);
    if (principalError) return principalError;
    const reconciliationError = walletReconciliationErrorResponse(error);
    if (reconciliationError) return reconciliationError;
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const declaredLength = Number.parseInt(
      request.headers.get("content-length") ?? "0",
      10,
    );
    if (Number.isFinite(declaredLength) && declaredLength > 21 * 1024 * 1024) {
      return privateJson(
        {
          error: "Chat request exceeds the 21 MB transport limit.",
          code: "chat_payload_too_large",
        },
        413,
      );
    }
    if (process.env.DATABASE_URL?.trim()) {
      await enforcePublicChatNetworkAdmission({
        clientAddress: resolvePublicChatClientAddress(request),
      });
    }
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return publicRuntimeError(runtime.status);
    const { body, attachmentFiles } = await readPublicChatRequest(request);
    if (!body.message) return privateJson({ error: "Message is required." }, 400);
    if (!publicMemoryDisclosureMatches(
      body.memoryDisclosure,
      runtime.governedMemoryDisclosure,
    )) {
      return privateJson(
        {
          error: "Memory policy changed. Review the updated disclosure before sending.",
          code: "memory_disclosure_stale",
          governedMemoryDisclosure: runtime.governedMemoryDisclosure,
        },
        409,
      );
    }

    const { principal, sessionState } =
      await resolvePublicAudienceRequestPrincipal({
      representativeSlug: slug,
      cookieStore: await cookies(),
    });

    if (process.env.DATABASE_URL?.trim()) {
      await enforcePublicChatPrincipalAdmission({
        representativeId: runtime.setup.id,
        audienceIdentityId: principal.audienceIdentityId,
      });
    }

    try {
      const contact = await resolveWebAudienceContact({
        representativeId: runtime.setup.id,
        representativeSlug: slug,
        audienceId: principal.audienceId,
      });
      assertPublicAudienceResourceOwner(
        principal,
        contact.audienceIdentityId,
      );
      const conversation = await resolveWebAudienceConversation({
        representativeId: runtime.setup.id,
        contactId: contact.id,
        audienceId: principal.audienceId,
      });
      assertPublicAudienceResourceOwner(
        principal,
        conversation.audienceIdentityId,
      );
      const clientMessageId =
        body.clientMessageId || `web:${principal.audienceId}:${Date.now()}`;
      if (attachmentFiles.length && !process.env.DATABASE_URL?.trim()) {
        return privateJson(
          {
            error: "Attachments require the persistent conversation service.",
            code: "attachments_unavailable",
          },
          503,
        );
      }
      const externalUserId = await resolvePublicWalletExternalUserId({
        principal,
        representativeSlug: slug,
      });
      let accepted: Awaited<ReturnType<typeof acceptInboundConversationMessage>>;
      let uploadedAttachments: Awaited<ReturnType<typeof uploadPublicChatAttachments>> = [];
      try {
        uploadedAttachments = await uploadPublicChatAttachments({
          representativeId: runtime.setup.id,
          audienceIdentityId: principal.audienceIdentityId,
          clientMessageId,
          message: body.message,
          files: attachmentFiles,
        });
        accepted = await acceptInboundConversationMessage({
          representativeSlug: slug,
          conversationId: conversation.id,
          text: body.message,
          senderId: principal.audienceId,
          ...(principal.sourceIdentityLinkId
            ? { sourceIdentityLinkId: principal.sourceIdentityLinkId }
            : {}),
          senderDisplayName:
            contact.displayName || contact.username || "Web visitor",
          clientMessageId,
          channel: "web",
          ...(uploadedAttachments.length
            ? { attachments: uploadedAttachments }
            : {}),
          walletBilling: {
            externalUserId,
            representativeId: runtime.setup.id,
            accessMode: runtime.accessMode,
            freeReplyLimit: runtime.setup.contract.freeReplyLimit,
            tokenAmount: 1,
            idempotencyKey: `public_chat:${conversation.id}:${clientMessageId}:reserve`,
          },
        });
      } catch (acceptError) {
        await cleanupPublicChatAttachments(uploadedAttachments);
        if (acceptError instanceof ServiceCreditRequiredError) {
          const usage = await derivePublicWalletUsage({
            representativeId: runtime.setup.id,
            externalUserId,
            freeRepliesUsed: acceptError.effectiveFreeRepliesUsed,
            freeReplyLimit: runtime.setup.contract.freeReplyLimit,
            accessMode: runtime.accessMode,
          });
          const response = privateJson(
            {
              error: acceptError.message,
              code: "service_credit_required",
              tier: resolvePublicChatTier(usage),
              usage,
            },
            402,
          );
          setPublicAudienceSessionCookie(
            response,
            request,
            slug,
            sessionState,
          );
          return response;
        }
        throw acceptError;
      }
      const usage = await derivePublicWalletUsage({
        representativeId: runtime.setup.id,
        externalUserId,
        freeRepliesUsed: conversation.freeRepliesUsed,
        freeReplyLimit: runtime.setup.contract.freeReplyLimit,
        accessMode: runtime.accessMode,
      });
      const response = NextResponse.json(
        {
          status: accepted.heldForOperator ? "waiting_human" : "queued",
          heldForOperator: accepted.heldForOperator,
          ...(accepted.run ? { runId: accepted.run.id } : {}),
          tier: resolvePublicChatTier(usage),
          usage,
        },
        { status: 202 },
      );
      response.headers.set("Cache-Control", "private, no-store");
      setPublicAudienceSessionCookie(
        response,
        request,
        slug,
        sessionState,
      );
      return response;
    } catch (error) {
      if (!shouldUseNonPersistentDemoChat(error, slug)) throw error;
    }

    const representative = buildRepresentativeRuntimeProfile(runtime.setup);
    const usage = deriveTierUsage({
      freeRepliesUsed: 0,
      freeReplyLimit: representative.contract.freeReplyLimit,
    });
    const plan = createConversationPlan({
      text: body.message,
      channel: "private_chat",
      representative,
      usage,
    });
    const subagent = resolveConversationSubagent(plan);
    let replyText = renderReplyPreview(representative, plan);
    let sourceDisclosure: "general_model" | undefined;
    if (plan.disposition === "answer") {
      const generated = await generateRepresentativeReply({
        representative,
        plan,
        subagent,
        userText: body.message,
        recalled: [],
        recentTurns: [],
        collectorState: null,
      });
      if (generated.ok) {
        replyText = generated.replyText;
        sourceDisclosure = "general_model";
      }
    }
    const response = NextResponse.json({
      status: "completed",
      reply: {
        role: "assistant",
        text: replyText,
        ...(sourceDisclosure ? { sourceDisclosure } : {}),
      },
      tier: resolvePublicChatTier(usage),
      usage,
    });
    response.headers.set("Cache-Control", "private, no-store");
    setPublicAudienceSessionCookie(response, request, slug, sessionState);
    return response;
  } catch (error) {
    if (error instanceof ConversationIngressValidationError) {
      return privateJson(
        {
          error: error.message,
          code: "invalid_chat_payload",
        },
        error.statusCode,
      );
    }
    if (error instanceof PublicChatRateLimitError) {
      const response = privateJson(
        {
          error: "Too many chat requests. Please try again later.",
          code: "public_chat_rate_limited",
          scope: error.scope,
        },
        429,
      );
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    const principalError = publicPrincipalErrorResponse(error);
    if (principalError) return principalError;
    const reconciliationError = walletReconciliationErrorResponse(error);
    if (reconciliationError) return reconciliationError;
    console.error("Failed to accept public chat message.", error);
    return NextResponse.json(
      { error: "Failed to accept chat message." },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}

async function readPublicChatRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      body: normalizePublicChatRequest(await request.json()),
      attachmentFiles: [] as File[],
    };
  }
  const form = await request.formData();
  const memoryDisclosureValue = form.get("memoryDisclosure");
  let memoryDisclosure: unknown = null;
  if (typeof memoryDisclosureValue === "string" && memoryDisclosureValue.trim()) {
    try {
      memoryDisclosure = JSON.parse(memoryDisclosureValue);
    } catch {
      memoryDisclosure = null;
    }
  }
  const attachmentFiles = form.getAll("attachments").filter(
    (value): value is File => typeof File !== "undefined" && value instanceof File,
  );
  return {
    body: normalizePublicChatRequest({
      message: form.get("message"),
      clientMessageId: form.get("clientMessageId"),
      memoryDisclosure,
    }),
    attachmentFiles,
  };
}

async function uploadPublicChatAttachments(input: {
  representativeId: string;
  audienceIdentityId: string;
  clientMessageId: string;
  message: string;
  files: File[];
}) {
  if (!input.files.length) return [];
  const attachmentDrafts = await Promise.all(input.files.map(async (file) => ({
    fileName: file.name,
    mimeType: resolvePublicChatAttachmentMimeType(file.name, file.type),
    sizeBytes: file.size,
    body: Buffer.from(await file.arrayBuffer()),
  })));
  const scopeHash = createHash("sha256")
    .update(`${input.representativeId}:${input.audienceIdentityId}:${input.clientMessageId}`)
    .digest("hex");
  const validated = validateInboundConversationPayload({
    representativeSlug: "public-upload-validation",
    conversationId: "public-upload-validation",
    text: input.message,
    clientMessageId: input.clientMessageId,
    channel: "web",
    attachments: attachmentDrafts.map((attachment, index) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      objectKey: `conversation-inputs/${input.representativeId}/${scopeHash}/${index}`,
    })),
  });
  const uploaded: Array<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    objectKey: string;
    checksum: string;
  }> = [];
  try {
    for (const [index, attachment] of attachmentDrafts.entries()) {
      const checksum = createHash("sha256").update(attachment.body).digest("hex");
      const objectKey = `${validated[index]!.objectKey}-${checksum}`;
      await writeArtifactObject({
        objectKey,
        body: attachment.body,
        contentType: attachment.mimeType,
      });
      uploaded.push({
        fileName: validated[index]!.fileName,
        mimeType: validated[index]!.mimeType,
        sizeBytes: validated[index]!.sizeBytes,
        objectKey,
        checksum,
      });
    }
    return uploaded;
  } catch (error) {
    await cleanupPublicChatAttachments(uploaded);
    throw error;
  }
}

function resolvePublicChatAttachmentMimeType(
  fileName: string,
  reportedType: string,
) {
  const normalized = reportedType.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  const extension = fileName.toLowerCase().split(".").pop();
  return extension === "json"
    ? "application/json"
    : extension === "pdf"
      ? "application/pdf"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : extension === "csv"
              ? "text/csv"
              : extension === "md" || extension === "markdown"
                ? "text/markdown"
                : extension === "txt"
                  ? "text/plain"
                  : "application/octet-stream";
}

async function cleanupPublicChatAttachments(
  attachments: Array<{ objectKey: string }>,
) {
  await Promise.allSettled(
    attachments.map((attachment) => deleteArtifactObject(attachment.objectKey)),
  );
}

export function resolvePublicChatClientAddress(request: Request) {
  const configuredHeader = process.env.PUBLIC_CHAT_CLIENT_IP_HEADER
    ?.trim()
    .toLowerCase();
  const candidates = configuredHeader
    ? [configuredHeader]
    : ["cf-connecting-ip", "x-real-ip"];
  for (const header of candidates) {
    const raw = request.headers.get(header)?.split(",", 1)[0]?.trim();
    if (raw && raw.length <= 128 && /^[0-9a-f:.]+$/i.test(raw)) return raw;
  }
  // Fail closed to one shared bucket when the deployment has not configured a
  // trusted proxy header. Never trust arbitrary X-Forwarded-For by default.
  return "unresolved";
}

async function derivePublicWalletUsage(input: {
  representativeId: string;
  externalUserId: string;
  freeRepliesUsed: number;
  freeReplyLimit: number;
  accessMode: "FREE" | "TRIAL_THEN_CREDITS" | "CREDITS_ONLY";
}) {
  const balance = process.env.DATABASE_URL?.trim()
    ? await getUserAgentWalletBalance({
        externalUserId: input.externalUserId,
        representativeId: input.representativeId,
      })
    : null;
  return {
    ...deriveTierUsage({
      freeRepliesUsed: input.freeRepliesUsed,
      freeReplyLimit:
        input.accessMode === "CREDITS_ONLY" ? 0 : input.freeReplyLimit,
      serviceCreditsAvailable: balance?.availableTokenAmount ?? 0,
      serviceCreditsReserved: balance?.reservedTokenAmount ?? 0,
      serviceCreditsPurchased: balance?.totalPurchasedTokenAmount ?? 0,
    }),
    accessMode: input.accessMode,
    unlimitedFreeAccess: input.accessMode === "FREE",
  };
}

async function resolvePublicWalletExternalUserId(input: {
  principal: PublicAudiencePrincipal;
  representativeSlug: string;
}) {
  if (!process.env.DATABASE_URL?.trim()) {
    return buildWebAudienceExternalUserId(
      input.representativeSlug,
      input.principal.audienceId,
    );
  }
  return resolvePublicAudienceWalletExternalUserId({
    audienceIdentityId: input.principal.audienceIdentityId,
    representativeSlug: input.representativeSlug,
    audienceId: input.principal.audienceId,
  });
}

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function publicRuntimeError(status: Exclude<Awaited<ReturnType<typeof getPublicRepresentativeRuntime>>["status"], "available">) {
  if (status === "not_found") return NextResponse.json({ error: "Representative not found." }, { status: 404 });
  if (status === "paused") return NextResponse.json({ error: "This representative is temporarily paused." }, { status: 423 });
  return NextResponse.json({ error: "This representative is not publicly available." }, { status: 404 });
}

function publicPrincipalErrorResponse(error: unknown) {
  const status = publicAudiencePrincipalErrorStatus(error);
  if (!status) return null;
  return privateJson(
    {
      error:
        status === 401
          ? "Authentication required."
          : "Audience account requires reconciliation.",
    },
    status,
  );
}

function walletReconciliationErrorResponse(error: unknown) {
  if (!(error instanceof AgentWalletReconciliationError)) return null;
  return privateJson(
    {
      error: "Wallet balance requires reconciliation.",
      code: "wallet_reconciliation_required",
    },
    409,
  );
}

function shouldUseNonPersistentDemoChat(error: unknown, representativeSlug: string): boolean {
  return process.env.NODE_ENV !== "production"
    && representativeSlug === demoRepresentative.slug
    && isPrismaUnavailableError(error);
}

function isPrismaUnavailableError(error: unknown): boolean {
  return error instanceof Error && /Can't reach database server|DATABASE_URL|P1001/i.test(error.message);
}
