import {
  assertSupportedCapabilitySchema,
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  derivePlannerCapabilitySchema,
  stableSha256,
} from "@delegate/runtime";
import { Prisma } from "@prisma/client";

import { listRemoteMcpTools } from "./mcp";
import { prisma } from "./prisma";
import { SessionError } from "./session-error";

export function assertLiveMcpToolSchemaPin(input: {
  toolName: string;
  expectedToolSchemaHash: string;
  tools: Array<{
    name: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
}) {
  const live = input.tools.find((tool) => tool.name === input.toolName);
  if (!live) {
    throw new SessionError(409, "mcp_tool_not_exposed_by_server");
  }
  const liveSchemaHash = stripHash(stableSha256({
    inputSchema: live.inputSchema,
    outputSchema: live.outputSchema ?? null,
  }));
  if (liveSchemaHash !== stripHash(input.expectedToolSchemaHash)) {
    throw new SessionError(409, "mcp_tool_schema_drift_replan_required");
  }
}

export async function syncRepresentativeMcpToolDefinitions(bindingId: string) {
  const binding = await prisma.representativeMcpBinding.findUnique({
    where: { id: bindingId },
    select: {
      id: true,
      slug: true,
      serverUrl: true,
      transportKind: true,
      allowedToolNames: true,
      defaultToolName: true,
      enabled: true,
      approvalRequired: true,
      configRevision: true,
    },
  });
  if (!binding || !binding.enabled) {
    throw new SessionError(404, "mcp_binding_not_available");
  }
  const tools = await listRemoteMcpTools({
    binding: {
      serverUrl: binding.serverUrl,
      transportKind: binding.transportKind.toLowerCase() as "streamable_http" | "sse",
    },
  });
  const allowed = normalizeAllowedToolNames(
    binding.allowedToolNames,
    binding.defaultToolName,
  );
  const selected = tools.filter((tool) => allowed.has(tool.name));
  if (!selected.length) {
    throw new SessionError(409, "mcp_binding_has_no_published_tools");
  }
  const bindingDefinitionHash = stableSha256({
    bindingId: binding.id,
    slug: binding.slug,
    serverUrl: binding.serverUrl,
    transportKind: binding.transportKind,
    allowedToolNames: [...allowed].sort(),
    defaultToolName: binding.defaultToolName,
    approvalRequired: binding.approvalRequired,
    configRevision: binding.configRevision,
  });
  const observedAt = new Date();
  const definitions = selected.map((tool) => {
    const plannerInputSchema = derivePlannerCapabilitySchema(tool.inputSchema, {
      closeObjects: true,
    });
    assertSupportedCapabilitySchema(
      plannerInputSchema,
      `MCP ${binding.slug}/${tool.name} input`,
      true,
    );
    if (tool.outputSchema) {
      const plannerOutputSchema = derivePlannerCapabilitySchema(tool.outputSchema, {
        closeObjects: false,
        dropUnsupportedOutputKeywords: true,
      });
      assertSupportedCapabilitySchema(
        plannerOutputSchema,
        `MCP ${binding.slug}/${tool.name} output`,
        false,
      );
    }
    return {
      tool,
      toolSchemaHash: stableSha256({
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
      }),
    };
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`mcp-tool-definitions:${binding.id}`}))
    `;
    await tx.mcpToolDefinition.updateMany({
      where: {
        bindingId: binding.id,
        OR: [
          { bindingRevision: { not: binding.configRevision } },
          { exactToolName: { notIn: definitions.map(({ tool }) => tool.name) } },
        ],
        supersededAt: null,
      },
      data: {
        availability: "superseded",
        supersededAt: observedAt,
      },
    });
    const persisted = [];
    for (const { tool, toolSchemaHash } of definitions) {
      persisted.push(await tx.mcpToolDefinition.upsert({
        where: {
          bindingId_bindingRevision_exactToolName: {
            bindingId: binding.id,
            bindingRevision: binding.configRevision,
            exactToolName: tool.name,
          },
        },
        create: {
          bindingId: binding.id,
          bindingRevision: binding.configRevision,
          exactToolName: tool.name,
          description: sanitizeMcpDiscoveryDescription(tool.description),
          inputSchema: tool.inputSchema as Prisma.InputJsonObject,
          outputSchema: tool.outputSchema
            ? tool.outputSchema as Prisma.InputJsonObject
            : Prisma.JsonNull,
          toolSchemaHash: stripHash(toolSchemaHash),
          bindingDefinitionHash: stripHash(bindingDefinitionHash),
          canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
          observedAnnotations: tool.annotations
            ? tool.annotations as Prisma.InputJsonObject
            : Prisma.JsonNull,
          availability: "ready",
          observedAt,
        },
        update: {
          description: sanitizeMcpDiscoveryDescription(tool.description),
          inputSchema: tool.inputSchema as Prisma.InputJsonObject,
          outputSchema: tool.outputSchema
            ? tool.outputSchema as Prisma.InputJsonObject
            : Prisma.JsonNull,
          toolSchemaHash: stripHash(toolSchemaHash),
          bindingDefinitionHash: stripHash(bindingDefinitionHash),
          observedAnnotations: tool.annotations
            ? tool.annotations as Prisma.InputJsonObject
            : Prisma.JsonNull,
          availability: "ready",
          observedAt,
          supersededAt: null,
        },
      }));
    }
    return persisted;
  });
}

function normalizeAllowedToolNames(value: unknown, defaultToolName: string | null) {
  const names = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  if (!names.length && defaultToolName?.trim()) names.push(defaultToolName.trim());
  return new Set(names);
}

function stripHash(value: string) {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

/**
 * MCP tool descriptions are useful retrieval data, but are controlled by the
 * remote server. Persist only bounded plain text and never derive effect,
 * approval, idempotency, or owner semantic metadata from it or annotations.
 */
export function sanitizeMcpDiscoveryDescription(value: string | undefined) {
  const normalized = value
    ?.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
  return normalized || null;
}
