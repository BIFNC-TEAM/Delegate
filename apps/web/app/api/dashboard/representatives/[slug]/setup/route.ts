import { after, NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  getRepresentativeSetupSnapshot,
  maybeSyncRepresentativeOpenVikingResources,
  RepresentativeSetupConflictError,
  updateRepresentativeSetup,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccess,
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

  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = (await request.json()) as Record<string, unknown>;
    const snapshot = await updateRepresentativeSetup({
      representativeSlug: slug,
      syncOpenViking: false,
      changedBy: session?.ownerId ?? "local-owner",
      input: {
        knowledgePackRevision:
          typeof body.knowledgePackRevision === "number"
            ? body.knowledgePackRevision
            : -1,
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
                handoffWindowHours: Number(
                  (body.contract as { handoffWindowHours?: number }).handoffWindowHours ?? 0,
                ),
              }
            : {
                freeReplyLimit: 0,
                handoffWindowHours: 0,
              },
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
                autoApproveTokenLimit: Number(
                  (body.compute as { autoApproveTokenLimit?: number }).autoApproveTokenLimit ??
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
                capabilityModes: normalizeCapabilityModes(
                  (body.compute as { capabilityModes?: unknown }).capabilityModes,
                ),
              }
            : {
                enabled: false,
                defaultPolicyMode: "ask",
                baseImage: "debian:bookworm-slim",
                maxSessionMinutes: 15,
                autoApproveTokenLimit: 0,
                artifactRetentionDays: 14,
                networkMode: "no_network",
                networkAllowlist: [],
                filesystemMode: "workspace_only",
                capabilityModes: normalizeCapabilityModes(null),
              },
        delegation: normalizeDelegationSetup(body.delegation),
      },
    });

    after(async () => {
      await maybeSyncRepresentativeOpenVikingResources({
        representativeSlug: snapshot.slug,
        trigger: "setup_update",
        ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      });
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }
    if (error instanceof RepresentativeSetupConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.statusCode },
      );
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

function normalizeCapabilityModes(value: unknown) {
  const defaults = {
    exec: "ask",
    read: "allow",
    write: "ask",
    process: "ask",
    browser: "ask",
    mcp: "ask",
  } as const;
  const record = typeof value === "object" && value ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const mode = record[key];
    return [key, mode === "allow" || mode === "ask" || mode === "deny" ? mode : fallback];
  })) as Record<keyof typeof defaults, "allow" | "ask" | "deny">;
}

function normalizeDelegationSetup(value: unknown) {
  const record = typeof value === "object" && value ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    naturalLanguageEnabled:
      record.naturalLanguageEnabled === undefined ? true : Boolean(record.naturalLanguageEnabled),
    explicitComputeEnabled:
      record.explicitComputeEnabled === undefined ? true : Boolean(record.explicitComputeEnabled),
    maxSteps: Number(record.maxSteps ?? 5),
    maxEstimatedTokens: Number(record.maxEstimatedTokens ?? 0),
    knowledgeScope: record.knowledgeScope === "public_knowledge"
      ? "public_knowledge" as const
      : "user_input_only" as const,
  };
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
