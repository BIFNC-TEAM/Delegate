import { NextResponse } from "next/server";

import {
  getRepresentativeSetupSnapshot,
  updateRepresentativeSetup,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const snapshot = await getRepresentativeSetupSnapshot(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load representative setup.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const snapshot = await updateRepresentativeSetup({
      representativeSlug: slug,
      input: {
        ownerName: String(body.ownerName ?? ""),
        name: String(body.name ?? ""),
        tagline: String(body.tagline ?? ""),
        tone: String(body.tone ?? ""),
        languages: Array.isArray(body.languages)
          ? body.languages.filter((entry): entry is string => typeof entry === "string")
          : [],
        groupActivation:
          body.groupActivation === "mention_only" ||
          body.groupActivation === "reply_or_mention" ||
          body.groupActivation === "always"
            ? body.groupActivation
            : "reply_or_mention",
        publicMode: Boolean(body.publicMode),
        humanInLoop: Boolean(body.humanInLoop),
        handoffPrompt: String(body.handoffPrompt ?? ""),
        contract:
          typeof body.contract === "object" && body.contract
            ? {
                freeReplyLimit: Number(
                  (body.contract as { freeReplyLimit?: number }).freeReplyLimit ?? 0,
                ),
                freeScope: Array.isArray((body.contract as { freeScope?: unknown[] }).freeScope)
                  ? (body.contract as { freeScope: unknown[] }).freeScope.filter(
                      (
                        entry,
                      ): entry is
                        | "faq"
                        | "collaboration"
                        | "pricing"
                        | "materials"
                        | "scheduling"
                        | "handoff"
                        | "refund"
                        | "discount"
                        | "candidate"
                        | "media"
                        | "support"
                        | "restricted"
                        | "unknown" =>
                        typeof entry === "string",
                    )
                  : [],
                paywalledIntents: Array.isArray(
                  (body.contract as { paywalledIntents?: unknown[] }).paywalledIntents,
                )
                  ? (body.contract as { paywalledIntents: unknown[] }).paywalledIntents.filter(
                      (
                        entry,
                      ): entry is
                        | "faq"
                        | "collaboration"
                        | "pricing"
                        | "materials"
                        | "scheduling"
                        | "handoff"
                        | "refund"
                        | "discount"
                        | "candidate"
                        | "media"
                        | "support"
                        | "restricted"
                        | "unknown" =>
                        typeof entry === "string",
                    )
                  : [],
                handoffWindowHours: Number(
                  (body.contract as { handoffWindowHours?: number }).handoffWindowHours ?? 0,
                ),
              }
            : {
                freeReplyLimit: 0,
                freeScope: [],
                paywalledIntents: [],
                handoffWindowHours: 0,
              },
        pricing: Array.isArray(body.pricing)
          ? body.pricing.map((plan) => {
              const record = typeof plan === "object" && plan ? plan : {};
              return {
                tier:
                  (record as { tier?: string }).tier === "free" ||
                  (record as { tier?: string }).tier === "pass" ||
                  (record as { tier?: string }).tier === "deep_help" ||
                  (record as { tier?: string }).tier === "sponsor"
                    ? (record as { tier: "free" | "pass" | "deep_help" | "sponsor" }).tier
                    : "free",
                name: String((record as { name?: string }).name ?? ""),
                stars: Number((record as { stars?: number }).stars ?? 0),
                summary: String((record as { summary?: string }).summary ?? ""),
                includedReplies: Number(
                  (record as { includedReplies?: number }).includedReplies ?? 0,
                ),
                includesPriorityHandoff: Boolean(
                  (record as { includesPriorityHandoff?: boolean }).includesPriorityHandoff,
                ),
              };
            })
          : [],
        knowledgePack:
          typeof body.knowledgePack === "object" && body.knowledgePack
            ? {
                identitySummary: String(
                  (body.knowledgePack as { identitySummary?: string }).identitySummary ?? "",
                ),
                faq: normalizeKnowledgeDocuments(
                  (body.knowledgePack as { faq?: unknown[] }).faq,
                ),
                materials: normalizeKnowledgeDocuments(
                  (body.knowledgePack as { materials?: unknown[] }).materials,
                ),
                policies: normalizeKnowledgeDocuments(
                  (body.knowledgePack as { policies?: unknown[] }).policies,
                ),
              }
            : {
                identitySummary: "",
                faq: [],
                materials: [],
                policies: [],
              },
        compute:
          typeof body.compute === "object" && body.compute
            ? {
                enabled: Boolean((body.compute as { enabled?: boolean }).enabled),
                defaultPolicyMode:
                  (body.compute as { defaultPolicyMode?: string }).defaultPolicyMode === "allow" ||
                  (body.compute as { defaultPolicyMode?: string }).defaultPolicyMode === "deny" ||
                  (body.compute as { defaultPolicyMode?: string }).defaultPolicyMode === "ask"
                    ? (body.compute as { defaultPolicyMode: "allow" | "ask" | "deny" })
                        .defaultPolicyMode
                    : "ask",
                baseImage: String((body.compute as { baseImage?: string }).baseImage ?? ""),
                maxSessionMinutes: Number(
                  (body.compute as { maxSessionMinutes?: number }).maxSessionMinutes ?? 15,
                ),
                autoApproveBudgetCents: Number(
                  (body.compute as { autoApproveBudgetCents?: number }).autoApproveBudgetCents ??
                    0,
                ),
                artifactRetentionDays: Number(
                  (body.compute as { artifactRetentionDays?: number }).artifactRetentionDays ??
                    14,
                ),
                networkMode:
                  (body.compute as { networkMode?: string }).networkMode === "allowlist" ||
                  (body.compute as { networkMode?: string }).networkMode === "full" ||
                  (body.compute as { networkMode?: string }).networkMode === "no_network"
                    ? (body.compute as { networkMode: "no_network" | "allowlist" | "full" })
                        .networkMode
                    : "no_network",
                networkAllowlist: Array.isArray((body.compute as { networkAllowlist?: unknown }).networkAllowlist)
                  ? (body.compute as { networkAllowlist: unknown[] }).networkAllowlist
                      .filter((value): value is string => typeof value === "string")
                      .map((value) => value.trim())
                      .filter(Boolean)
                  : [],
                filesystemMode:
                  (body.compute as { filesystemMode?: string }).filesystemMode ===
                    "read_only_workspace" ||
                  (body.compute as { filesystemMode?: string }).filesystemMode ===
                    "ephemeral_full" ||
                  (body.compute as { filesystemMode?: string }).filesystemMode ===
                    "workspace_only"
                    ? (body.compute as {
                        filesystemMode:
                          | "workspace_only"
                          | "read_only_workspace"
                          | "ephemeral_full";
                      }).filesystemMode
                    : "workspace_only",
              }
            : {
                enabled: false,
                defaultPolicyMode: "ask",
                baseImage: "debian:bookworm-slim",
                maxSessionMinutes: 15,
                autoApproveBudgetCents: 0,
                artifactRetentionDays: 14,
                networkMode: "no_network",
                networkAllowlist: [],
                filesystemMode: "workspace_only",
              },
      },
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update representative setup.",
      },
      { status: 400 },
    );
  }
}

function normalizeKnowledgeDocuments(value: unknown): Array<{
  id?: string;
  title: string;
  kind: "bio" | "faq" | "policy" | "pricing" | "case_study" | "deck" | "calendar" | "download";
  summary: string;
  url?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = typeof entry === "object" && entry ? entry : {};
    const kind = (record as { kind?: string }).kind;

    return {
      ...(typeof (record as { id?: string }).id === "string"
        ? { id: (record as { id: string }).id }
        : {}),
      title: String((record as { title?: string }).title ?? ""),
      kind:
        kind === "bio" ||
        kind === "faq" ||
        kind === "policy" ||
        kind === "pricing" ||
        kind === "case_study" ||
        kind === "deck" ||
        kind === "calendar" ||
        kind === "download"
          ? kind
          : "faq",
      summary: String((record as { summary?: string }).summary ?? ""),
      ...(typeof (record as { url?: string }).url === "string" &&
      (record as { url: string }).url.trim()
        ? { url: (record as { url: string }).url }
        : {}),
    };
  });
}
