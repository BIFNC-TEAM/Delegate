import {
  getRepresentativeRuntimeAuthoritySnapshot,
  type RepresentativeRuntimeAuthoritySnapshot,
} from "@delegate/web-data";

import { prisma } from "./prisma";
import { SessionError } from "./session-error";

export type ComputeRuntimeAuthorityContext = {
  representativeId: string;
  representativeSlug: string;
  pinnedRepresentativeVersionId?: string | null;
  activeVersionId?: string | null;
  requestedBy?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  generationRunId?: string | null;
  delegationTaskId?: string | null;
};

export async function loadComputeRuntimeAuthority(
  context: ComputeRuntimeAuthorityContext,
): Promise<RepresentativeRuntimeAuthoritySnapshot> {
  if (context.pinnedRepresentativeVersionId !== undefined) {
    const representativeVersionId = context.pinnedRepresentativeVersionId?.trim();
    if (!representativeVersionId) {
      throw new SessionError(409, "compute_session_version_missing");
    }

    const authority = await getRepresentativeRuntimeAuthoritySnapshot(
      context.representativeSlug,
      representativeVersionId,
    );
    if (!authority) {
      throw new SessionError(409, "representative_runtime_authority_unavailable");
    }
    return authority;
  }

  const pinnedVersionIds: string[] = [];
  let hasPinnedRuntimeContext = false;

  if (context.conversationId && !context.contactId) {
    throw new SessionError(409, "conversation_contact_context_missing");
  }
  if (context.generationRunId && !context.conversationId) {
    throw new SessionError(409, "generation_run_conversation_context_missing");
  }

  if (context.contactId) {
    const contact = await prisma.contact.findFirst({
      where: {
        id: context.contactId,
        representativeId: context.representativeId,
      },
      select: { id: true },
    });
    if (!contact) throw new SessionError(409, "contact_context_mismatch");
  }

  if (context.generationRunId) {
    hasPinnedRuntimeContext = true;
    const run = await prisma.generationRun.findFirst({
      where: {
        id: context.generationRunId,
        delegationTaskId: context.delegationTaskId ?? null,
        conversation: {
          representativeId: context.representativeId,
          ...(context.conversationId ? { id: context.conversationId } : {}),
          ...(context.contactId ? { contactId: context.contactId } : {}),
        },
      },
      select: { representativeVersionId: true },
    });
    if (!run) throw new SessionError(409, "generation_run_context_mismatch");
    if (!run.representativeVersionId) {
      throw new SessionError(409, "generation_run_version_missing");
    }
    pinnedVersionIds.push(run.representativeVersionId);
  }

  if (context.delegationTaskId) {
    hasPinnedRuntimeContext = true;
    const task = await prisma.delegationTask.findFirst({
      where: {
        id: context.delegationTaskId,
        representativeId: context.representativeId,
        contactId: context.contactId ?? null,
        originConversationId: context.conversationId ?? null,
        ...(context.generationRunId
          ? { generationRuns: { some: { id: context.generationRunId } } }
          : {}),
      },
      select: { representativeVersionId: true },
    });
    if (!task) throw new SessionError(409, "delegation_task_context_mismatch");
    if (!task.representativeVersionId) {
      throw new SessionError(409, "delegation_task_version_missing");
    }
    pinnedVersionIds.push(task.representativeVersionId);
  }

  if (context.conversationId) {
    hasPinnedRuntimeContext = true;
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: context.conversationId,
        representativeId: context.representativeId,
        ...(context.contactId ? { contactId: context.contactId } : {}),
      },
      select: { id: true, activeEpisodeId: true },
    });
    if (!conversation) throw new SessionError(409, "conversation_context_mismatch");

    const episode = conversation.activeEpisodeId
      ? await prisma.conversationEpisode.findFirst({
          where: {
            id: conversation.activeEpisodeId,
            conversationId: conversation.id,
          },
          select: { representativeVersionId: true },
        })
      : await prisma.conversationEpisode.findFirst({
          where: { conversationId: conversation.id },
          orderBy: { sequence: "desc" },
          select: { representativeVersionId: true },
        });
    if (!episode?.representativeVersionId) {
      throw new SessionError(409, "conversation_episode_version_missing");
    }
    pinnedVersionIds.push(episode.representativeVersionId);
  }

  const uniquePinnedVersionIds = [...new Set(pinnedVersionIds)];
  if (uniquePinnedVersionIds.length > 1) {
    throw new SessionError(409, "compute_runtime_version_context_mismatch");
  }

  const representativeVersionId =
    uniquePinnedVersionIds[0] ??
    (!hasPinnedRuntimeContext ? context.activeVersionId ?? undefined : undefined);
  if (!representativeVersionId) {
    throw new SessionError(409, "representative_version_required_for_compute");
  }

  const authority = await getRepresentativeRuntimeAuthoritySnapshot(
    context.representativeSlug,
    representativeVersionId,
  );
  if (!authority) {
    throw new SessionError(409, "representative_runtime_authority_unavailable");
  }
  return authority;
}
